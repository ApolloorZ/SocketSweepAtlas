// ============================================================================
// daemon.cpp — Anti-MTP Android Storage Analyzer Engine
// ============================================================================

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include <arpa/inet.h>
#include <dirent.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include <filesystem>
#include <iostream>

// Linked statically from the NDK sysroot, so the binary carries no runtime
// dependency on a system library that might not be exposed to it.
#include <zlib.h>

// ── Configuration ───────────────────────────────────────────────────────────
namespace cfg {
    constexpr uint16_t    PORT              = 5050;
    constexpr const char* BIND_ADDR         = "127.0.0.1";
    constexpr const char* DEFAULT_ROOT      = "/sdcard";
    constexpr int         LISTEN_BACKLOG    = 4;
    constexpr int         MAX_DEPTH         = 64;
    constexpr int         RECV_TIMEOUT_SEC  = 30;
}

// ── Globals ─────────────────────────────────────────────────────────────────
static volatile sig_atomic_t g_running = 1;
static void on_signal(int) { g_running = 0; }
static std::string g_scan_root;  // tracks the active scan root for delete validation

// ── Delete path validation ──────────────────────────────────────────────────

/// Returns true if `target` is strictly inside `root` (component-wise).
/// Rejects: the root itself, paths that escape via "..", and non-existent paths.
static bool path_is_safe_to_delete(const std::string& target, const std::string& root) {
    if (target.empty() || root.empty()) return false;

    // Canonicalize both paths to resolve "..", symlinks, etc.
    char* real_target = ::realpath(target.c_str(), nullptr);
    char* real_root   = ::realpath(root.c_str(), nullptr);
    if (!real_target || !real_root) {
        free(real_target);
        free(real_root);
        return false;
    }

    std::string rt(real_target);
    std::string rr(real_root);
    free(real_target);
    free(real_root);

    // Target must not be the root itself.
    if (rt == rr) return false;

    // Target must start with root + "/" (component-wise, not just prefix).
    // This prevents /sdcard/Down from matching /sdcard/Downloads.
    if (rr.back() != '/') rr += '/';
    return rt.size() > rr.size() && rt.compare(0, rr.size(), rr) == 0;
}

// ── Network & Streaming Helpers ─────────────────────────────────────────────
class JsonStream {
    int fd;
    std::string buf;
    // The scan answer is tens of megabytes of repeated path prefixes, and the
    // wireless adb tunnel carries about 2.4 MB/s — the payload IS the wait. When
    // gzip is on, everything written here leaves compressed; the bytes themselves
    // are unchanged, so the computer only has to unzip before parsing.
    bool gz_on = false;
    z_stream zs{};
    // A tunnel that drops mid-transfer used to go unnoticed: every caller ignores
    // write()'s result, so the answer was simply shorter than it should have been.
    // Recording it here turns that into a visible failure instead.
    bool broken = false;

    static bool send_all(int fd, const char* p, size_t left) {
        while (left > 0) {
            ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) return false;
            p    += n;
            left -= static_cast<size_t>(n);
        }
        return true;
    }

    bool send_out(const char* p, size_t len) {
        const bool ok = send_all(fd, p, len);
        if (!ok) broken = true;
        return ok;
    }

    // Pushes whatever is buffered through deflate and sends what came out.
    bool pump(bool final) {
        if (buf.empty() && !final) return true;
        zs.next_in  = reinterpret_cast<Bytef*>(const_cast<char*>(buf.data()));
        zs.avail_in = static_cast<uInt>(buf.size());
        char outbuf[32 * 1024];
        int rc;
        do {
            zs.next_out  = reinterpret_cast<Bytef*>(outbuf);
            zs.avail_out = static_cast<uInt>(sizeof(outbuf));
            rc = deflate(&zs, final ? Z_FINISH : Z_NO_FLUSH);
            size_t produced = sizeof(outbuf) - zs.avail_out;
            if (produced > 0 && !send_out(outbuf, produced)) return false;
            if (rc == Z_BUF_ERROR) break;
            if (rc != Z_OK && rc != Z_STREAM_END) return false;
        } while (final ? rc != Z_STREAM_END : (zs.avail_in > 0 || zs.avail_out == 0));
        buf.clear();
        return true;
    }

public:
    JsonStream(int fd) : fd(fd) {
        buf.reserve(64 * 1024);
    }
    ~JsonStream() {
        if (gz_on) { pump(true); deflateEnd(&zs); }
        else { flush(); }
    }

    /// Starts a gzip member. On failure the stream stays plain, which is slower
    /// but still correct — compression must never be able to break a scan.
    bool gzip_start() {
        if (gz_on) return true;
        if (deflateInit2(&zs, Z_BEST_SPEED, Z_DEFLATED, 16 + 15, 8, Z_DEFAULT_STRATEGY) != Z_OK) return false;
        gz_on = true;
        return true;
    }

    bool write(const char* data, size_t len) {
        if (gz_on) {
            buf.append(data, len);
            return buf.size() < 32 * 1024 ? true : pump(false);
        }
        if (buf.size() + len > buf.capacity()) {
            if (!flush()) return false;
        }
        if (len >= buf.capacity()) {
            return send_out(data, len);
        } else {
            buf.append(data, len);
            return true;
        }
    }

    bool write(const std::string& s) { return write(s.data(), s.size()); }

    bool flush() {
        if (gz_on) return pump(false);
        if (!buf.empty()) {
            bool ok = send_out(buf.data(), buf.size());
            buf.clear();
            return ok;
        }
        return true;
    }

    /// False once a send has failed: the answer is incomplete and must not be
    /// presented as if it were good.
    bool ok() const { return !broken; }

    /// Closes the gzip member so the reader gets a valid trailer.
    bool finish() {
        if (!gz_on) return flush();
        bool ok = pump(true);
        deflateEnd(&zs);
        gz_on = false;
        return ok;
    }
};

static std::string recv_line(int fd) {
    std::string line;
    char c;
    while (true) {
        ssize_t n = ::recv(fd, &c, 1, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        if (c == '\n') break;
        if (c != '\r') line += c;
    }
    return line;
}

static std::string trim(std::string s) {
    while (!s.empty() && s.back()  == ' ') s.pop_back();
    size_t start = s.find_first_not_of(' ');
    return (start == std::string::npos) ? "" : s.substr(start);
}

// ── Data Model ──────────────────────────────────────────────────────────────
struct FileNode {
    std::string              name;
    std::string              path;
    bool                     is_dir = false;
    int64_t                  size   = 0;
    int64_t                  mtime  = 0;   // seconds since epoch; 0 when unknown
    std::vector<FileNode>    children;
};

struct ScanStats {
    int64_t files      = 0;
    int64_t dirs       = 0;
    int64_t total_size = 0;
    int64_t errors     = 0;
};

// ── JSON helpers ────────────────────────────────────────────────────────────
static void json_escape_into(JsonStream& out, const std::string& s) {
    // Ordinary bytes go out in whole runs. A 250k-file scan is tens of megabytes
    // of ordinary bytes, and calling write() once per character dominated the
    // entire scan on the phone's CPU. Output is byte for byte what the
    // byte-at-a-time version produced.
    const unsigned char* data = reinterpret_cast<const unsigned char*>(s.data());
    const size_t n = s.size();
    size_t i = 0;
    while (i < n) {
        size_t run = i;
        while (run < n && data[run] >= 0x20 && data[run] != '"' && data[run] != '\\') run++;
        if (run > i) {
            out.write(reinterpret_cast<const char*>(data + i), run - i);
            i = run;
            continue;
        }
        switch (data[i]) {
            case '"':  out.write("\\\"", 2); break;
            case '\\': out.write("\\\\", 2); break;
            case '\b': out.write("\\b", 2); break;
            case '\f': out.write("\\f", 2); break;
            case '\n': out.write("\\n", 2); break;
            case '\r': out.write("\\r", 2); break;
            case '\t': out.write("\\t", 2); break;
            default: {
                char buf[8];
                int len = std::snprintf(buf, sizeof(buf), "\\u%04x", data[i]);
                out.write(buf, len);
            }
        }
        i++;
    }
}

/// Numbers into a stack buffer; `std::to_string` allocated twice per node.
static void write_number(JsonStream& out, int64_t value) {
    char buf[24];
    int len = std::snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(value));
    out.write(buf, static_cast<size_t>(len));
}

static void serialize_node(JsonStream& out, const FileNode& node) {
    out.write("{\"name\":\"");
    json_escape_into(out, node.name);
    out.write("\",\"path\":\"");
    json_escape_into(out, node.path);
    out.write("\",\"type\":");
    out.write(node.is_dir ? "\"directory\"" : "\"file\"");
    out.write(",\"size\":");
    write_number(out, node.size);
    out.write(",\"mtime\":");
    write_number(out, node.mtime);

    if (node.is_dir) {
        out.write(",\"children\":[");
        for (size_t i = 0; i < node.children.size(); ++i) {
            if (i > 0) out.write(",");
            serialize_node(out, node.children[i]);
        }
        out.write("]");
    }
    out.write("}");
}

// ── Recursive Scanner ───────────────────────────────────────────────────────
static FileNode scan(const std::string& path, const std::string& name,
                     ScanStats& st, int depth)
{
    FileNode node;
    node.name = name;
    node.path = path;

    struct stat info{};
    int stat_res = (depth == 0) ? ::stat(path.c_str(), &info) : ::lstat(path.c_str(), &info);
    if (stat_res != 0) {
        ++st.errors;
        return node;
    }
    node.mtime = static_cast<int64_t>(info.st_mtime);

    if (depth > 0 && S_ISLNK(info.st_mode)) return node;

    if (S_ISREG(info.st_mode)) {
        node.size = info.st_size;
        ++st.files;
        st.total_size += info.st_size;
        return node;
    }

    if (!S_ISDIR(info.st_mode)) return node;

    node.is_dir = true;
    ++st.dirs;

    if (depth >= cfg::MAX_DEPTH) { ++st.errors; return node; }

    DIR* dir = ::opendir(path.c_str());
    if (!dir) { ++st.errors; return node; }

    struct dirent* ent;
    while ((ent = ::readdir(dir)) != nullptr) {
        if (ent->d_name[0] == '.') {
            if (ent->d_name[1] == '\0') continue;
            if (ent->d_name[1] == '.' && ent->d_name[2] == '\0') continue;
        }

        #ifdef DT_LNK
        if (ent->d_type == DT_LNK) continue;
        #endif

        std::string child_path = path + '/' + ent->d_name;

        FileNode child = scan(child_path, ent->d_name, st, depth + 1);
        node.size += child.size;
        node.children.push_back(std::move(child));
    }
    ::closedir(dir);

    std::sort(node.children.begin(), node.children.end(),
              [](const FileNode& a, const FileNode& b) {
                  return a.size > b.size;
              });

    return node;
}

// ── Command dispatch ────────────────────────────────────────────────────────
static void handle_client(int fd) {
    struct timeval tv { cfg::RECV_TIMEOUT_SEC, 0 };
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    std::string cmd = trim(recv_line(fd));
    if (cmd.empty()) return;

    JsonStream out(fd);

    if (cmd == "PING") {
        out.write("{\"status\":\"ok\",\"message\":\"pong\"}\n");
    }
    else if (cmd == "SHUTDOWN") {
        out.write("{\"status\":\"ok\",\"message\":\"shutting down\"}\n");
        out.flush();
        g_running = 0;
        return;
    }
    else if (cmd.rfind("DELETE ", 0) == 0) {
        std::string target = trim(cmd.substr(7));

        // Server-side delete guard: validate target is strictly inside the scan root.
        if (g_scan_root.empty()) {
            out.write("{\"status\":\"error\",\"message\":\"No scan performed yet — cannot validate delete target\"}\n");
        } else if (!path_is_safe_to_delete(target, g_scan_root)) {
            out.write("{\"status\":\"error\",\"message\":\"Delete rejected: path is outside scan root or equals scan root\"}\n");
        } else {
            std::error_code ec;
            std::uintmax_t removed = std::filesystem::remove_all(target, ec);
            if (ec) {
                out.write("{\"status\":\"error\",\"message\":\"");
                json_escape_into(out, ec.message());
                out.write("\"}\n");
            } else {
                out.write("{\"status\":\"ok\",\"message\":\"Deleted ");
                out.write(std::to_string(removed));
                out.write(" items\"}\n");
            }
        }
    }
    else if (cmd.rfind("SCAN", 0) == 0) {
        std::string root = cfg::DEFAULT_ROOT;
        if (cmd.size() > 4) {
            std::string arg = trim(cmd.substr(4));
            if (!arg.empty()) root = arg;
        }
        while (root.size() > 1 && root.back() == '/') root.pop_back();

        std::string root_name = root;
        auto pos = root.rfind('/');
        if (pos != std::string::npos && pos + 1 < root.size())
            root_name = root.substr(pos + 1);

        std::fprintf(stderr, "[engine] SCAN \"%s\" ...\n", root.c_str());
        g_scan_root = root;  // store for delete validation

        // Compress the answer; if zlib refuses to start, send it plain. A slower
        // scan is acceptable, a broken one is not.
        if (!out.gzip_start()) std::fprintf(stderr, "[engine] gzip unavailable, sending plain\n");

        auto t0 = std::chrono::steady_clock::now();
        ScanStats stats{};
        FileNode tree = scan(root, root_name, stats, 0);
        auto t1 = std::chrono::steady_clock::now();
        int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();

        std::fprintf(stderr, "[engine] Done: %lld files, %lld dirs, "
                     "%lld bytes, %lld errors, %lld ms\n",
                     (long long)stats.files, (long long)stats.dirs,
                     (long long)stats.total_size, (long long)stats.errors,
                     (long long)ms);

        out.write("{\"status\":\"ok\",\"scan_time_ms\":");
        out.write(std::to_string(ms));
        out.write(",\"total_files\":");
        out.write(std::to_string(stats.files));
        out.write(",\"total_dirs\":");
        out.write(std::to_string(stats.dirs));
        out.write(",\"total_size\":");
        out.write(std::to_string(stats.total_size));
        out.write(",\"errors\":");
        out.write(std::to_string(stats.errors));
        out.write(",\"tree\":");
        serialize_node(out, tree);
        out.write("}\n");
    }
    else {
        out.write("{\"status\":\"error\",\"message\":\"Unknown command\"}\n");
    }
    // Closes the gzip member, which is what lets the reader know the answer ends here.
    const bool sent = out.finish();
    if (!sent || !out.ok()) {
        std::fprintf(stderr, "[engine] answer incomplete: the tunnel broke mid-transfer\n");
    }
}

// ── Main ────────────────────────────────────────────────────────────────────
int main(int argc, char* argv[]) {
    std::ios_base::sync_with_stdio(false);

    uint16_t port = cfg::PORT;
    if (argc > 1) port = static_cast<uint16_t>(std::atoi(argv[1]));

    ::signal(SIGINT,  on_signal);
    ::signal(SIGTERM, on_signal);
    ::signal(SIGPIPE, SIG_IGN);

    int srv = ::socket(AF_INET, SOCK_STREAM, 0);
    if (srv < 0) { std::perror("[engine] socket"); return 1; }

    int yes = 1;
    ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(port);
    ::inet_pton(AF_INET, cfg::BIND_ADDR, &addr.sin_addr);

    if (::bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
        std::perror("[engine] bind");
        ::close(srv);
        return 1;
    }
    if (::listen(srv, cfg::LISTEN_BACKLOG) < 0) {
        std::perror("[engine] listen");
        ::close(srv);
        return 1;
    }

    std::fprintf(stderr, "[engine] Listening on %s:%u  (pid %d)\n",
                 cfg::BIND_ADDR, port, static_cast<int>(::getpid()));

    while (g_running) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(srv, &fds);
        struct timeval tv { 1, 0 };
        int sel = ::select(srv + 1, &fds, nullptr, nullptr, &tv);
        if (sel <= 0) continue;

        struct sockaddr_in peer{};
        socklen_t peer_len = sizeof(peer);
        int client = ::accept(srv, reinterpret_cast<sockaddr*>(&peer), &peer_len);
        if (client < 0) continue;

        std::fprintf(stderr, "[engine] Client connected\n");
        handle_client(client);
        ::close(client);
        std::fprintf(stderr, "[engine] Client disconnected\n");
    }

    ::close(srv);
    std::fprintf(stderr, "[engine] Shutdown complete.\n");
    return 0;
}

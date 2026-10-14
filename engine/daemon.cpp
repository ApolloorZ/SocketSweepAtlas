// ============================================================================
// daemon.cpp — Anti-MTP Android Storage Analyzer Engine
// ============================================================================

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <cerrno>
#include <string>
#include <vector>
#include <set>
#if defined(__linux__)
#include <linux/magic.h>
#include <sys/vfs.h>
#endif

#include <arpa/inet.h>
#include <dirent.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
// Linked statically from the NDK sysroot, so the binary carries no runtime
// dependency on a system library that might not be exposed to it.
#include <zlib.h>

#include "safe_delete.h"
#include <iostream>
#include <fstream>
#include <poll.h>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

// ── Configuration ───────────────────────────────────────────────────────────
namespace cfg {
    constexpr uint16_t    PORT              = 5050;
    constexpr const char* BIND_ADDR         = "127.0.0.1";
    constexpr const char* DEFAULT_ROOT      = "/sdcard";
    constexpr int         LISTEN_BACKLOG    = 4;
    constexpr int         MAX_DEPTH         = 64;
    constexpr int         RECV_TIMEOUT_SEC  = 30;
    constexpr size_t      MAX_COMMAND_BYTES = 16 * 1024;
    constexpr int         DEFAULT_SCAN_THREADS = 4;
    // Reading a directory on this phone blocks rather than burns CPU, and four
    // readers is where the gain flattened out. The launch flag accepts up to
    // eight so the number can be probed without recompiling.
    constexpr int         MAX_SCAN_THREADS = 8;
}

// ── Globals ─────────────────────────────────────────────────────────────────
static volatile sig_atomic_t g_running = 1;
static void on_signal(int) { g_running = 0; }
static safe_delete::Root g_scan_root; // pins the successful scan root for deletion
static std::string g_session_token;
static bool g_read_only = false;
static int g_scan_threads = cfg::DEFAULT_SCAN_THREADS;

// Per-phase scan timing (see SCAN in handle_client). Counters reset per scan.
static int64_t g_sort_ns    = 0;  // cumulative time sorting directory children
static int64_t g_send_ns    = 0;  // cumulative time blocked in ::send (socket writes)
static int64_t g_send_bytes = 0;  // cumulative bytes handed to ::send

static inline int64_t ns_to_ms(int64_t ns) { return ns / 1000000; }

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
        const size_t total = left;
        const auto t0 = std::chrono::steady_clock::now();
        while (left > 0) {
            ssize_t n = ::send(fd, p, left, MSG_NOSIGNAL);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) break;
            p    += n;
            left -= static_cast<size_t>(n);
        }
        g_send_ns    += std::chrono::duration_cast<std::chrono::nanoseconds>(
                            std::chrono::steady_clock::now() - t0).count();
        g_send_bytes += total - left;
        return left == 0;
    }

    bool send_out(const char* p, size_t len) {
        const bool ok = send_all(fd, p, len);
        if (!ok) broken = true;
        return ok;
    }

    // Pushes whatever is buffered through deflate and sends what came out.
    // `sync` additionally asks deflate to emit everything it is holding back,
    // which is what a byte count taken mid-answer needs in order to be true.
    bool pump(bool final, bool sync = false) {
        if (buf.empty() && !final) return true;
        zs.next_in  = reinterpret_cast<Bytef*>(const_cast<char*>(buf.data()));
        zs.avail_in = static_cast<uInt>(buf.size());
        char outbuf[32 * 1024];
        int rc;
        do {
            zs.next_out  = reinterpret_cast<Bytef*>(outbuf);
            zs.avail_out = static_cast<uInt>(sizeof(outbuf));
            rc = deflate(&zs, final ? Z_FINISH : (sync ? Z_SYNC_FLUSH : Z_NO_FLUSH));
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

    /// Drains the compressor without closing the gzip member, so a measurement
    /// taken next covers everything written so far.
    bool sync() {
        if (!gz_on) return flush();
        return pump(false, true);
    }

    /// Closes the gzip member so the reader gets a valid trailer.
    bool finish() {
        if (!gz_on) return flush();
        bool ok = pump(true);
        deflateEnd(&zs);
        gz_on = false;
        return ok;
    }
};

static bool recv_line(int fd, std::string& line) {
    line.clear();
    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::seconds(cfg::RECV_TIMEOUT_SEC);
    char c;
    while (true) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()).count();
        if (remaining <= 0) return false;
        struct pollfd event { fd, POLLIN, 0 };
        int ready = ::poll(&event, 1, static_cast<int>(remaining));
        if (ready < 0 && errno == EINTR) continue;
        if (ready <= 0) return false;
        ssize_t n = ::recv(fd, &c, 1, 0);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return false;
        if (c == '\n') return true;
        // Never normalize path bytes or execute an incomplete/oversized line.
        if (c == '\r' || c == '\0' || line.size() >= cfg::MAX_COMMAND_BYTES) return false;
        line += c;
    }
}

static bool valid_token(const std::string& token) {
    return token.size() == 64 && std::all_of(token.begin(), token.end(), [](char c) {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
    });
}

// ── Data Model ──────────────────────────────────────────────────────────────
struct FileNode {
    std::string              name;
    std::string              path;
    bool                     is_dir = false;
    int64_t                  size   = 0;
    int64_t                  mtime  = 0;   // seconds since epoch; 0 when unknown
    std::vector<FileNode>    children;
    // Which slot of the parallel walk holds this directory's own entries. Only
    // that walk needs it, and it is a number rather than a pointer because the
    // entries are produced by other threads and attached afterwards.
    uint32_t                 dir_id = UINT32_MAX;
};

struct ScanStats {
    int64_t files      = 0;
    int64_t dirs       = 0;
    int64_t total_size = 0;
    int64_t errors     = 0;
    int64_t skipped    = 0;
    std::set<std::pair<dev_t, ino_t>> seen;
};

// ── JSON helpers ────────────────────────────────────────────────────────────
static void json_escape_into(JsonStream& out, const std::string& s) {
    for (unsigned char c : s) {
        switch (c) {
            case '"':  out.write("\\\"", 2); break;
            case '\\': out.write("\\\\", 2); break;
            case '\b': out.write("\\b", 2); break;
            case '\f': out.write("\\f", 2); break;
            case '\n': out.write("\\n", 2); break;
            case '\r': out.write("\\r", 2); break;
            case '\t': out.write("\\t", 2); break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    int len = std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out.write(buf, len);
                } else {
                    char b = static_cast<char>(c);
                    out.write(&b, 1);
                }
        }
    }
}

static void serialize_node(JsonStream& out, const FileNode& node) {
    out.write("{\"name\":\"");
    json_escape_into(out, node.name);
    out.write("\",\"path\":\"");
    json_escape_into(out, node.path);
    out.write("\",\"type\":");
    out.write(node.is_dir ? "\"directory\"" : "\"file\"");
    out.write(",\"size\":");
    out.write(std::to_string(node.size));
    out.write(",\"mtime\":");
    out.write(std::to_string(node.mtime));

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
static bool virtual_filesystem(const std::string& path) {
#if defined(__linux__)
    struct statfs fs{};
    if (::statfs(path.c_str(), &fs) != 0) return false; // traversal reports access errors
    switch (static_cast<unsigned long>(fs.f_type)) {
        case PROC_SUPER_MAGIC: case SYSFS_MAGIC: case DEVPTS_SUPER_MAGIC:
        case CGROUP_SUPER_MAGIC: case CGROUP2_SUPER_MAGIC: case DEBUGFS_MAGIC:
        case TRACEFS_MAGIC: case SECURITYFS_MAGIC: case SELINUX_MAGIC:
        case BPF_FS_MAGIC: case NSFS_MAGIC:
            return true;
        default: return false;
    }
#else
    (void)path;
    return false;
#endif
}

static bool root_mount_alias(const char* name) {
    // /data/media is the canonical internal media tree. FUSE views can have
    // different device/inode identities, so inode deduplication alone cannot
    // prevent them being counted again through /mnt or /storage. APEX images
    // are already represented by their package files on /system or /data.
    return std::strcmp(name, "mnt") == 0 || std::strcmp(name, "storage") == 0 ||
           std::strcmp(name, "data_mirror") == 0 || std::strcmp(name, "apex") == 0 ||
           std::strcmp(name, "proc") == 0 || std::strcmp(name, "sys") == 0 ||
           std::strcmp(name, "dev") == 0;
}

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
    node.is_dir = S_ISDIR(info.st_mode);

    if (g_read_only && (S_ISREG(info.st_mode) || S_ISDIR(info.st_mode))) {
        if ((S_ISDIR(info.st_mode) && virtual_filesystem(path)) ||
            !st.seen.emplace(info.st_dev, info.st_ino).second) {
            ++st.skipped;
            return node;
        }
    }

    if (S_ISREG(info.st_mode)) {
        node.size = info.st_size;
        ++st.files;
        st.total_size += info.st_size;
        return node;
    }

    if (!S_ISDIR(info.st_mode)) return node;

    node.is_dir = true;
    ++st.dirs;
    // Whatever filesystem this directory lives on is now fair game for a delete
    // anchored to this scan — see safe_delete::Root::allows().
    g_scan_root.allow_device(info.st_dev);

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

        if (g_read_only && path == "/" && root_mount_alias(ent->d_name)) {
            ++st.skipped;
            continue;
        }
        std::string child_path = (path == "/" ? path : path + '/') + ent->d_name;

        FileNode child = scan(child_path, ent->d_name, st, depth + 1);
        node.size += child.size;
        node.children.push_back(std::move(child));
    }
    ::closedir(dir);

    const auto sort_t0 = std::chrono::steady_clock::now();
    std::sort(node.children.begin(), node.children.end(),
              [](const FileNode& a, const FileNode& b) {
                  return a.size > b.size;
              });
    g_sort_ns += std::chrono::duration_cast<std::chrono::nanoseconds>(
                     std::chrono::steady_clock::now() - sort_t0).count();

    return node;
}

// ── Parallel Directory Walk ─────────────────────────────────────────────────
// The walk above is one recursive descent on one thread: 250k files took this
// phone ~24 seconds of nothing but waiting for readdir and lstat. Those calls
// block instead of computing, and concurrent walks on this storage were measured
// to overlap almost perfectly, so directories are handed out to a small pool
// instead. Each worker finishes one directory and drops its entries in a slot;
// the tree is put together on one thread afterwards, in the same order the
// single-threaded walk produced, so the answer bytes are unchanged.
//
// Upstream solves the same problem with `parallel_scan.h`, which re-opens every
// queued directory from the pinned scan root one component at a time. That is
// stronger against a directory being swapped mid-scan, and it costs about four
// times as long on this phone (13-18 s against 3-4 s, measured over three
// interleaved rounds on 258k files), so the fork keeps its own walk here. A
// swap during a scan can only ever report a wrong size; a swap during a
// *delete* is the dangerous case, and that path is anchored by safe_delete.h.
namespace {

struct DirJob {
    uint32_t    id;      // the slot this directory's entries go into
    int         depth;   // depth of this directory itself
    std::string path;
};

struct Walk {
    std::mutex                m;
    std::condition_variable   cv;
    std::deque<DirJob>        ready;
    size_t                    running = 0;
    bool                      done    = false;
    std::deque<std::vector<FileNode>> slots;

    /// Reserve a slot for a directory that was just discovered.
    uint32_t add_slot() {
        std::lock_guard<std::mutex> lk(m);
        slots.emplace_back();
        return static_cast<uint32_t>(slots.size() - 1);
    }

    void set_slot(uint32_t id, std::vector<FileNode>&& kids) {
        std::lock_guard<std::mutex> lk(m);
        slots[id] = std::move(kids);
    }

    void push(DirJob job) {
        {
            std::lock_guard<std::mutex> lk(m);
            ready.push_back(std::move(job));
        }
        cv.notify_one();
    }

    /// False once the walk is over. Waiting on the predicate rather than the
    /// notification alone means a wakeup aimed at a thread that was busy cannot
    /// strand a directory in `ready`.
    bool take(DirJob& out) {
        std::unique_lock<std::mutex> lk(m);
        cv.wait(lk, [this] { return done || !ready.empty(); });
        if (done) return false;
        out = std::move(ready.front());
        ready.pop_front();
        ++running;
        return true;
    }

    /// A job never waits for another job, so the only way the queue can be empty
    /// for good is no work running and nothing ready.
    void finish() {
        std::lock_guard<std::mutex> lk(m);
        if (--running == 0 && ready.empty()) {
            done = true;
            cv.notify_all();
        }
    }
};

/// Read one directory: stat every entry, queue the subdirectories, put the
/// finished entry list in the job's slot.
void walk_dir(Walk& w, const DirJob& job, ScanStats& st) {
    std::vector<FileNode> kids;
    DIR* dir = ::opendir(job.path.c_str());
    if (!dir) {
        ++st.errors;
        w.set_slot(job.id, std::move(kids));
        return;
    }

    struct dirent* ent;
    while ((ent = ::readdir(dir)) != nullptr) {
        if (ent->d_name[0] == '.') {
            if (ent->d_name[1] == '\0') continue;
            if (ent->d_name[1] == '.' && ent->d_name[2] == '\0') continue;
        }

        #ifdef DT_LNK
        if (ent->d_type == DT_LNK) continue;
        #endif

        FileNode child;
        child.name = ent->d_name;
        // Same single-slash rule as the recursive walk: a root of "/" must not
        // produce "//name", or the two walks disagree about the same file.
        child.path = job.path == "/" ? job.path : job.path + '/';
        child.path += ent->d_name;

        struct stat info{};
        if (::lstat(child.path.c_str(), &info) != 0) {
            ++st.errors;
            kids.push_back(std::move(child));
            continue;
        }
        child.mtime = static_cast<int64_t>(info.st_mtime);

        // Every entry reached here is a child of some directory, so it is always
        // deeper than the scan root: a link is recorded as an empty leaf.
        if (S_ISLNK(info.st_mode)) {
            kids.push_back(std::move(child));
            continue;
        }
        if (S_ISREG(info.st_mode)) {
            child.size = info.st_size;
            ++st.files;
            st.total_size += info.st_size;
            kids.push_back(std::move(child));
            continue;
        }
        if (!S_ISDIR(info.st_mode)) {
            kids.push_back(std::move(child));
            continue;
        }

        child.is_dir = true;
        ++st.dirs;
        // Record the filesystem this directory lives on, so a delete anchored to
        // this scan may descend where the scan actually looked (see
        // safe_delete::Root::allows — /sdcard/Android/data is its own mount).
        g_scan_root.allow_device(info.st_dev);
        if (job.depth + 1 >= cfg::MAX_DEPTH) {
            ++st.errors;
            kids.push_back(std::move(child));
            continue;
        }

        DirJob next;
        next.id    = w.add_slot();
        next.depth = job.depth + 1;
        next.path  = child.path;
        child.dir_id = next.id;
        kids.push_back(std::move(child));
        w.push(std::move(next));
    }
    ::closedir(dir);

    w.set_slot(job.id, std::move(kids));
}

/// Attach a directory's entries, then fold the sizes upward and sort — exactly
/// the order the recursive walk did it in, which is what keeps ties in the same
/// place and the bytes of the answer identical.
void build_node(FileNode& node, Walk& w) {
    if (!node.is_dir || node.dir_id == UINT32_MAX) return;

    std::vector<FileNode> kids = std::move(w.slots[node.dir_id]);
    for (FileNode& kid : kids) {
        build_node(kid, w);
        node.size += kid.size;
    }

    const auto t0 = std::chrono::steady_clock::now();
    std::sort(kids.begin(), kids.end(),
              [](const FileNode& a, const FileNode& b) { return a.size > b.size; });
    g_sort_ns += std::chrono::duration_cast<std::chrono::nanoseconds>(
                     std::chrono::steady_clock::now() - t0).count();

    node.children = std::move(kids);
}

}  // namespace

/// Walk `root` with a pool of directory readers and return the finished tree.
/// Returns the number of readers that actually ran, which is what the answer
/// reports as `scan_threads`.
static int scan_parallel(const std::string& root, const std::string& name,
                         ScanStats& st, FileNode& node, int requested)
{
    node.name = name;
    node.path = root;

    struct stat info{};
    if (::stat(root.c_str(), &info) != 0) {
        ++st.errors;
        return 0;
    }
    node.mtime = static_cast<int64_t>(info.st_mtime);

    // The root is the one path the walk follows through a link, as before.
    if (S_ISREG(info.st_mode)) {
        node.size = info.st_size;
        ++st.files;
        st.total_size += info.st_size;
        return 0;
    }
    if (!S_ISDIR(info.st_mode)) return 0;

    node.is_dir = true;
    ++st.dirs;

    int threads = requested;
    if (const unsigned cores = std::thread::hardware_concurrency(); cores > 0 && threads > static_cast<int>(cores))
        threads = static_cast<int>(cores);
    if (threads < 1) threads = 1;

    Walk w;
    node.dir_id = w.add_slot();
    w.push(DirJob{node.dir_id, 0, root});

    std::vector<std::thread> pool;
    pool.reserve(static_cast<size_t>(threads));
    for (int i = 1; i < threads; ++i) {
        pool.emplace_back([&w, &st] {
            DirJob job;
            while (w.take(job)) { walk_dir(w, job, st); w.finish(); }
        });
    }

    // The thread that asked for the scan reads directories too.
    {
        DirJob job;
        while (w.take(job)) { walk_dir(w, job, st); w.finish(); }
    }

    for (std::thread& t : pool) t.join();

    build_node(node, w);
    return threads;
}

// ── Command dispatch ────────────────────────────────────────────────────────
static void handle_client(int fd) {
    struct timeval tv { cfg::RECV_TIMEOUT_SEC, 0 };
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    JsonStream out(fd);
    std::string auth;
    if (!recv_line(fd, auth) || auth != "AUTH " + g_session_token) {
        out.write("{\"status\":\"error\",\"message\":\"Authentication failed\"}\n");
        return;
    }
    std::string cmd;
    if (!recv_line(fd, cmd) || cmd.empty()) {
        out.write("{\"status\":\"error\",\"message\":\"Invalid command framing\"}\n");
        return;
    }

    if (cmd == "PING") {
        out.write("{\"status\":\"ok\",\"message\":\"pong\",\"protocol_version\":3,\"uid\":");
        out.write(std::to_string(::geteuid()));
        out.write(",\"read_only\":");
        out.write(g_read_only ? "true" : "false");
        out.write("}\n");
    }
    else if (cmd == "SHUTDOWN") {
        out.write("{\"status\":\"ok\",\"message\":\"shutting down\"}\n");
        out.flush();
        g_running = 0;
        return;
    }
    else if (cmd.rfind("DELETE ", 0) == 0) {
        if (g_read_only) {
            out.write("{\"status\":\"error\",\"message\":\"Root scans are read-only; deletion is disabled\"}\n");
            return;
        }
        std::string target = cmd.substr(7);

        const auto result = safe_delete::remove(g_scan_root, target, cfg::MAX_DEPTH);
        if (!result.error.empty()) {
            out.write("{\"status\":\"error\",\"message\":\"");
            json_escape_into(out, result.error);
            if (result.removed > 0) {
                out.write("; some items were removed. Rescan before trying again");
            }
            out.write("\"}\n");
        } else {
            out.write("{\"status\":\"ok\",\"message\":\"Deleted ");
            out.write(std::to_string(result.removed));
            out.write(" items\"}\n");
        }
    }
    else if (cmd == "SCAN" || cmd.rfind("SCAN ", 0) == 0) {
        std::string root = cfg::DEFAULT_ROOT;
        if (cmd.size() > 4) {
            std::string arg = cmd.substr(5);
            if (!arg.empty()) root = arg;
        }
        while (root.size() > 1 && root.back() == '/') root.pop_back();

        if (g_read_only) {
            // Resolve aliases once so /./ or a symlink to / cannot bypass the
            // whole-device exclusions. Read-only scans never enable deletion.
            char* canonical = ::realpath(root.c_str(), nullptr);
            if (!canonical) {
                out.write("{\"status\":\"error\",\"message\":\"Scan root is not an accessible directory\"}\n");
                return;
            }
            root = canonical;
            std::free(canonical);
            if (virtual_filesystem(root)) {
                out.write("{\"status\":\"error\",\"message\":\"Virtual filesystems are excluded from root scans\"}\n");
                return;
            }
        }

        std::string root_name = root;
        auto pos = root.rfind('/');
        if (pos != std::string::npos && pos + 1 < root.size())
            root_name = root.substr(pos + 1);

        std::fprintf(stderr, "[engine] SCAN \"%s\" ...\n", root.c_str());
        g_scan_root.clear();

        if (!g_scan_root.open(root)) {
            out.write("{\"status\":\"error\",\"message\":\"Scan root is not an accessible directory\"}\n");
            return;
        }

        g_sort_ns    = 0;
        g_send_ns    = 0;
        g_send_bytes = 0;

        // Compress the answer; if zlib refuses to start, send it plain. A slower
        // scan is acceptable, a broken one is not.
        if (!out.gzip_start()) std::fprintf(stderr, "[engine] gzip unavailable, sending plain\n");

        auto t0 = std::chrono::steady_clock::now();
        ScanStats stats{};
        FileNode tree;
        int scan_threads = 1;
        if (g_read_only) {
            // Preserve serial, scan-wide inode deduplication and exclusions.
            tree = scan(root, root_name, stats, 0);
        } else {
            scan_threads = scan_parallel(root, root_name, stats, tree, g_scan_threads);
        }
        if (!g_scan_root.unchanged()) {
            g_scan_root.clear();
            out.write("{\"status\":\"error\",\"message\":\"Scan root changed during scan; scan again\"}\n");
            return;
        }
        auto t1 = std::chrono::steady_clock::now();
        int64_t ms = std::chrono::duration_cast<std::chrono::milliseconds>(t1 - t0).count();
        int64_t traverse_ms = ms - ns_to_ms(g_sort_ns);
        if (traverse_ms < 0) traverse_ms = 0;

        std::fprintf(stderr, "[engine] Done: %lld files, %lld dirs, "
                     "%lld bytes, %lld errors, %lld ms "
                     "(traverse %lld ms, sort %lld ms)\n",
                     (long long)stats.files, (long long)stats.dirs,
                     (long long)stats.total_size, (long long)stats.errors,
                     (long long)ms, (long long)traverse_ms,
                     (long long)ns_to_ms(g_sort_ns));

        out.write("{\"status\":\"ok\",\"scan_time_ms\":");
        out.write(std::to_string(ms));
        out.write(",\"scan_threads\":");
        out.write(std::to_string(scan_threads));
        out.write(",\"total_files\":");
        out.write(std::to_string(stats.files));
        out.write(",\"total_dirs\":");
        out.write(std::to_string(stats.dirs));
        out.write(",\"total_size\":");
        out.write(std::to_string(stats.total_size));
        out.write(",\"errors\":");
        out.write(std::to_string(stats.errors));
        out.write(",\"skipped\":");
        out.write(std::to_string(stats.skipped));
        out.write(",\"read_only\":");
        out.write(g_read_only ? "true" : "false");
        out.write(",\"tree\":");
        serialize_node(out, tree);

        // The phase numbers can only be taken once the tree has gone out, and
        // with compression on most of it is still inside the compressor's
        // buffer at this point. sync() pushes that buffer through deflate *and*
        // asks it to emit what it is holding back, without closing the gzip
        // member — finish() does that once the answer is complete — so the
        // counters below cover the whole payload and the reader still gets one
        // well-formed stream.
        out.sync();
        const auto t2 = std::chrono::steady_clock::now();
        const int64_t serialize_ms = std::chrono::duration_cast<std::chrono::milliseconds>(t2 - t1).count();
        const int64_t send_ms      = ns_to_ms(g_send_ns);

        out.write(",\"traverse_ms\":");
        out.write(std::to_string(traverse_ms));
        out.write(",\"sort_ms\":");
        out.write(std::to_string(ns_to_ms(g_sort_ns)));
        out.write(",\"serialize_ms\":");
        out.write(std::to_string(serialize_ms));
        out.write(",\"send_ms\":");
        out.write(std::to_string(send_ms));
        out.write(",\"bytes_sent\":");
        out.write(std::to_string(g_send_bytes));
        out.write("}\n");
    }
    else {
        out.write("{\"status\":\"error\",\"message\":\"Unknown command\"}\n");
    }
    // Closes the gzip member, which is what lets the reader know the answer
    // ends here, and reports a tunnel that broke part way through.
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

    // A shell-owned 0600 file supplies the secret, keeping it out of process
    // arguments. Consume and unlink it before accepting any connections.
    bool read_only_requested = false;
    bool threads_requested = false;
    bool valid_args = argc >= 3;
    for (int i = 3; valid_args && i < argc; ++i) {
        if (std::strcmp(argv[i], "--read-only") == 0 && !read_only_requested) {
            read_only_requested = true;
        } else if (std::strcmp(argv[i], "--threads") == 0 && !threads_requested && i + 1 < argc) {
            threads_requested = true;
            const std::string value = argv[++i];
            valid_args = value.size() == 1 && value[0] >= '1' &&
                         value[0] <= '0' + cfg::MAX_SCAN_THREADS;
            if (valid_args) g_scan_threads = value[0] - '0';
        } else {
            valid_args = false;
        }
    }
    if (!valid_args) {
        std::fprintf(stderr, "[engine] Usage: daemon PORT TOKEN_FILE [--read-only] [--threads 1..8]\n");
        return 1;
    }
    // Even an already-root ADB shell using the default launch cannot delete.
    g_read_only = read_only_requested || ::geteuid() == 0;
    {
        std::ifstream token_file(argv[2]);
        std::getline(token_file, g_session_token);
    }
    if (::unlink(argv[2]) != 0 || !valid_token(g_session_token)) {
        std::fprintf(stderr, "[engine] Failed to load session token\n");
        return 1;
    }

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

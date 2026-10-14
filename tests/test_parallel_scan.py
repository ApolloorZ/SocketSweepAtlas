"""The fork's own directory walk: same answer at one reader and at four.

Upstream ships `parallel_scan_test.cpp` for its walker; this fork deliberately kept
its own (the reason is measured and written down in engine/daemon.cpp), and that
walk lives inside the daemon rather than in a header a C++ test can call. So the
equivalence is proven the way the phone actually uses it: two daemons from the
same binary, one launched with `--threads 1` and one with `--threads 4`, scanning
the same fixture, must answer with the same tree and the same totals.

Upstream's streaming cases are not here, because this fork did not take
engine/stream_scan.h.
"""

import os
from pathlib import Path
import socket
import subprocess
import time
import unittest

from test_daemon import DaemonHarness


class WalkEquivalenceTests(DaemonHarness):
    """`self` walks with one reader; a second daemon from the same binary uses four."""
    scan_threads = 1

    def start_second(self, threads):
        token_file = Path(self.files.name) / f"session{threads}"
        token_file.write_text(self.token + "\n")
        token_file.chmod(0o600)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        process = subprocess.Popen([self.binary, str(port), str(token_file),
                                    "--threads", str(threads)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(process.kill)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                self.request("PING", port=port)
                return port
            except OSError:
                if process.poll() is not None:
                    self.fail(process.stderr.read().decode())
                time.sleep(0.02)
        self.fail(f"the daemon started with {threads} readers never answered")

    def fixture(self):
        # Wide, deep and uneven on purpose: after the readers finish, one thread
        # folds every directory's sizes upward and re-sorts its children, so a
        # tree of identical files would prove nothing about the order.
        for d in range(40):
            directory = self.root / f"album {d}"
            directory.mkdir()
            (directory / "empty").mkdir()
            for i in range(d % 7 + 1):
                (directory / f"file {i}").write_bytes(b"x" * (d + i))
        (self.root / "loose").write_bytes(b"12345")
        nested = self.root / "a" / "b" / "c"
        nested.mkdir(parents=True)
        (nested / "deep").write_bytes(b"1234567")

    def test_one_reader_and_four_agree_node_for_node(self):
        self.fixture()
        single = self.scan()
        port = self.start_second(4)
        four = self.request(f"SCAN {self.root}", port=port)
        self.assertEqual(four["status"], "ok")
        # The daemon never asks for more readers than the machine has cores.
        self.assertEqual(four["scan_threads"], min(4, os.cpu_count() or 4))
        for field in ["total_files", "total_dirs", "total_size", "errors", "skipped"]:
            self.assertEqual(single[field], four[field],
                             f"{field} differs between one reader and four")
        # Comparing the trees as parsed JSON compares name, path, type, size,
        # mtime, the order of every child and the depth of every node at once.
        self.assertEqual(single["tree"], four["tree"], "the tree itself differs")


class WalkProtocolTests(DaemonHarness):
    def test_worker_argument_validation(self):
        for flags in [["--threads"], ["--threads", "0"], ["--threads", "9"],
                      ["--threads", "4junk"], ["--threads", "-1"], ["--threads", "2", "--threads", "3"],
                      ["--read-only", "--read-only"], ["--unknown"]]:
            result = subprocess.run([self.binary, "5050", "unused-token", *flags],
                                    capture_output=True, text=True, timeout=3)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Usage:", result.stderr)

    def test_parallel_scan_keeps_protocol_and_directory_totals(self):
        for i in range(80):
            directory = self.root / str(i)
            directory.mkdir()
            (directory / "file").write_bytes(b"1234567")
        result = self.scan()
        # A root (uid 0) launch is forced onto the serial walk; the default here
        # is four readers, which the phone's core count can still hold down.
        expected = 1 if os.geteuid() == 0 else min(4, os.cpu_count() or 4)
        self.assertEqual(result["scan_threads"], expected)
        self.assertEqual(result["total_files"], 80)
        self.assertEqual(result["total_dirs"], 81)
        self.assertEqual(result["total_size"], 560)
        self.assertEqual(result["errors"], 0)
        self.assertEqual(result["tree"]["size"], 560)
        self.assertTrue(all(child["size"] == 7 for child in result["tree"]["children"]))

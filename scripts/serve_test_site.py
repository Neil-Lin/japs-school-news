#!/usr/bin/env python3
"""Serve the packaged test site with enough backlog for parallel browser cold starts."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class TestServer(ThreadingHTTPServer):
    request_queue_size = 128


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[1] / 'dist'
    TestServer(('127.0.0.1', 8743), partial(SimpleHTTPRequestHandler, directory=str(root))).serve_forever()

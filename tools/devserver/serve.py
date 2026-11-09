"""Test server: serves the repo root, and accepts POST /save/<name>.vrm into out/.

The save endpoint lets a browser test hand an exported VRM to scripts/check-vrm.ts. It only accepts
requests from this machine, even when the server listens on the network.
Usage: python3 tools/devserver/serve.py [port] [--lan]   (default 5288, localhost only)
  --lan  also listen on the network (LAN and Tailscale), e.g. to use the editor from another Mac
"""
import http.server
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Always revalidate: after a code or asset change, a normal reload gets the new files.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def do_POST(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self.send_error(403, "saving is only allowed from this machine")
            return
        match = re.fullmatch(r"/save/([\w.-]+\.vrm)", self.path)
        if not match:
            self.send_error(404)
            return
        data = self.rfile.read(int(self.headers["Content-Length"]))
        os.makedirs(os.path.join(ROOT, "out"), exist_ok=True)
        with open(os.path.join(ROOT, "out", match.group(1)), "wb") as handle:
            handle.write(data)
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--lan"]
    port = int(args[0]) if args else 5288
    host = "0.0.0.0" if "--lan" in sys.argv else "127.0.0.1"
    print(f"serving {ROOT} on http://{host}:{port}/web/editor/", flush=True)
    # The editor fires ~100 requests at once (thumbnails, textures); the default backlog of 5 refuses some.
    http.server.ThreadingHTTPServer.request_queue_size = 128
    http.server.ThreadingHTTPServer((host, port), Handler).serve_forever()

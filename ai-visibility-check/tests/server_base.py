"""One shared bootstrap for the tests that talk to the site server. Not a test module.

Starts `server.H` on a free loopback port in a daemon thread. `serve_forever(poll_interval=0.05)` keeps
`shutdown()` fast (the 0.5 s default cost ~0.5 s per test class)."""
import threading
import unittest


def start_server():
    """Returns (httpd, port, thread). Imports `server` lazily so the caller's sys.path/env setup runs first."""
    import server
    httpd = server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), server.H)
    thread = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    return httpd, httpd.server_address[1], thread


def stop_server(httpd, thread=None):
    httpd.shutdown()
    httpd.server_close()
    if thread is not None:
        thread.join(timeout=5)


class ServerCase(unittest.TestCase):
    """Class-level server: `cls.port`, and `cls.httpd` (alias `cls.srv`). Subclasses that override
    setUpClass/tearDownClass must call super()."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.httpd, cls.port, cls._server_thread = start_server()
        cls.srv = cls.httpd

    @classmethod
    def tearDownClass(cls):
        stop_server(cls.httpd, cls._server_thread)
        super().tearDownClass()

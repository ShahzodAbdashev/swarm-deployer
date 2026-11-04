"""Lab FTPS server (explicit TLS, pyftpdlib TLS_FTPHandler). Started by up.sh with the scratch venv:
  ftps_server.py <root> <port> <pasv_first> <user> <password> <certfile>
Serves the same folder as SFTP/FTP (path /releases). TLS is required for login and data (like a real FTPS box)."""
import sys

from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import TLS_FTPHandler
from pyftpdlib.servers import FTPServer

root, port, pasv, user, pw, cert = sys.argv[1:7]
auth = DummyAuthorizer()
auth.add_user(user, pw, root, perm="elradfmw")
TLS_FTPHandler.authorizer = auth
TLS_FTPHandler.certfile = cert
TLS_FTPHandler.tls_control_required = True
TLS_FTPHandler.tls_data_required = True
TLS_FTPHandler.passive_ports = range(int(pasv), int(pasv) + 10)
FTPServer(("127.0.0.1", int(port)), TLS_FTPHandler).serve_forever()

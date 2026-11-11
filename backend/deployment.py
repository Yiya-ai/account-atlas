"""Explicit HTTPS proxy trust and offline city gate; local mode stays unchanged."""
import hashlib
import ipaddress
import json
import re
import secrets
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from .vault import Problem


class CityGate:
    def __init__(self, directory, country, province, city):
        import ip2region.util as util
        import ip2region.searcher as xdb
        root = Path(directory)
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        expected = {f['file']: f['sha256'] for f in manifest['files']}
        self.searchers = {}
        self.allowed = (country, province, city)
        self.revision = manifest['commit']
        for number, version in ((4, util.IPv4), (6, util.IPv6)):
            name = f'ip2region_v{number}.xdb'
            path = root / name
            data = path.read_bytes()
            if hashlib.sha256(data).hexdigest() != expected[name]:
                raise ValueError('IP database checksum mismatch')
            util.verify_from_file(str(path))
            self.searchers[number] = xdb.new_with_buffer(version, data)

    @lru_cache(maxsize=8192)
    def permits(self, ip):
        address = ipaddress.ip_address(ip)
        if not address.is_global: return False
        fields = self.searchers[address.version].search(ip).split('|')
        # Current xdb format: country | province | city | ISP | ISO country code.
        return len(fields) == 5 and tuple(fields[:3]) == self.allowed and fields[4] == 'CN'


class PublicDeployment:
    def __init__(self, origin, proxy_token, city_gate, bootstrap_token):
        value = urlsplit(origin)
        if (value.scheme != 'https' or value.username or value.password or value.path
                or value.query or value.fragment or not value.hostname):
            raise ValueError('An exact HTTPS origin without a path is required')
        # IP HTTPS mode intentionally does not offer WebAuthn ceremonies.
        ipaddress.IPv4Address(value.hostname)
        if value.netloc != value.hostname + (f':{value.port}' if value.port else ''):
            raise ValueError('Noncanonical public origin')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', proxy_token):
            raise ValueError('A strong, independently generated proxy token is required')
        if not re.fullmatch(r'[A-Za-z0-9_-]{43,128}', bootstrap_token):
            raise ValueError('A strong initial setup token is required')
        self.origin, self.host, self.proxy_token = origin, value.netloc, proxy_token
        self.city_gate = city_gate
        self.bootstrap_hash = hashlib.sha256(bootstrap_token.encode('ascii')).digest()

    @classmethod
    def from_file(cls, filename):
        data = json.loads(Path(filename).read_text(encoding='utf-8'))
        token = Path(data['proxyTokenFile']).read_text(encoding='ascii').strip()
        bootstrap = Path(data['bootstrapTokenFile']).read_text(encoding='ascii').strip()
        gate = CityGate(data['geoipDirectory'], data['country'], data['province'], data['city'])
        return cls(data['origin'], token, gate, bootstrap)

    def authorize_setup(self, value):
        if (not isinstance(value, str) or not value.isascii() or len(value) > 128
                or not secrets.compare_digest(hashlib.sha256(value.encode('ascii')).digest(), self.bootstrap_hash)):
            raise Problem('首次初始化口令不正确。请使用服务器部署时生成的口令。', 403)

    def client_ip(self, request):
        token = request.headers.get('X-Atlas-Proxy-Token', '')
        if (request.remote_addr != '127.0.0.1' or not token.isascii()
                or not secrets.compare_digest(token, self.proxy_token)
                or request.headers.get('X-Atlas-Proto') != 'https'):
            raise Problem('只允许通过已配置的 HTTPS 入口访问。', 403)
        raw = request.headers.get('X-Atlas-Client-IP', '')
        try:
            if '%' in raw or len(raw) > 45: raise ValueError()
            address = ipaddress.ip_address(raw)
            if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                address = address.ipv4_mapped
            ip = str(address)
        except ValueError:
            raise Problem('无法确认连接来源，已拒绝访问。', 403) from None
        try:
            permitted = self.city_gate.permits(ip)
        except Exception:
            raise Problem('IP 归属校验暂不可用，已拒绝访问。', 503) from None
        if not permitted:
            raise Problem('当前来源不在允许的 IP 归属区域内。', 403)
        return ip

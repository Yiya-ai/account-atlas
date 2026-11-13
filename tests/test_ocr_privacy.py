import hashlib
import json
from pathlib import Path

from test_vault import app, c, H

ROOT = Path(__file__).resolve().parents[1]


def test_bundled_models_are_pinned_and_complete():
    models = ROOT / 'frontend/public/ocr/models'
    manifest = json.loads((models / 'manifest.json').read_text(encoding='utf-8-sig'))
    assert '65727574dfcd264acbb0c3e07860e4e9e9b22185' in manifest['source']
    assert {record['file'] for record in manifest['files']} == {'eng.traineddata', 'chi_sim.traineddata', 'chi_tra.traineddata', 'LICENSE'}
    for record in manifest['files']:
        assert hashlib.sha256((models / record['file']).read_bytes()).hexdigest() == record['sha256']


def test_ocr_resources_have_restrictive_worker_policy(app):
    client = app.test_client()
    for path in ('/', '/ocr/runtime/worker.min.js'):
        response = client.get(path)
        assert response.status_code in (200, 404)
        policy = response.headers['Content-Security-Policy']
        assert "worker-src 'self'" in policy
        assert "connect-src 'self'" in policy
        assert "'wasm-unsafe-eval'" in policy
        assert "'unsafe-eval'" not in policy and 'https:' not in policy


def test_no_screenshot_upload_endpoint_or_private_file_access(c):
    for path in ('/ocr/screenshot', '/ocr/runtime/worker.min.js'):
        assert c.post(path, data=b'SYNTHETIC_IMAGE', headers=H).status_code == 405
    assert c.get('/ocr/../../data/vault.db').status_code == 404
    assert c.get('/ocr/../../../backend/app.py').status_code == 404

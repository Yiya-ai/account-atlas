import time

import pytest

from backend.app import create_app
from test_vault import MASTER, H, app, c, post, add


def test_setting_persists_and_preserves_accounts(c, app):
    entry = add(c)
    assert c.get('/api/security').json['idleMinutes'] == 15
    assert post(c, '/security/idle', {'minutes': 37}).json['idleSeconds'] == 2220
    assert c.get('/api/status').json['idleSeconds'] == 2220
    assert c.get(f'/api/accounts/{entry["id"]}').json['identifier'] == entry['identifier']
    assert post(c, '/lock', {}).status_code == 200
    restarted = create_app(app.extensions['vault'].directory, testing=True).test_client()
    assert post(restarted, '/unlock', {'password': MASTER}).status_code == 200
    assert restarted.get('/api/security').json['idleMinutes'] == 37
    assert restarted.get('/api/status').json['idleSeconds'] == 2220


@pytest.mark.parametrize('minutes', [0, -1, 1441, 1.5, True, '30', None])
def test_invalid_values_do_not_change_setting(c, minutes):
    assert post(c, '/security/idle', {'minutes': minutes}).status_code == 400
    assert c.get('/api/status').json['idleSeconds'] == 900


def test_boundaries_authentication_and_csrf(c, app):
    for minutes in (1, 1440):
        assert post(c, '/security/idle', {'minutes': minutes}).status_code == 200
    outsider = app.test_client()
    for path in ('/security/idle', '/activity'):
        assert post(outsider, path, {'minutes': 20}).status_code == 401
        assert c.post('/api' + path, json={'minutes': 20}).status_code == 403


def test_idle_expiry_polling_and_activity(c, app):
    post(c, '/security/idle', {'minutes': 1})
    vault = app.extensions['vault']
    vault.last_used = time.monotonic() - 45
    previous = vault.last_used
    assert c.get('/api/status').json['unlocked'] is True
    assert vault.last_used == previous  # Polling is not user activity.
    assert post(c, '/activity', {}).status_code == 200
    assert vault.last_used > previous
    vault.last_used = time.monotonic() - 61
    assert post(c, '/activity', {}).status_code == 401  # Cannot revive an expired session.
    assert vault.key is None and vault.data is None


def test_restore_retains_current_timeout(c, app):
    vault = app.extensions['vault']
    import copy
    candidate = copy.deepcopy(vault.data)
    candidate['idleMinutes'] = 1440
    post(c, '/security/idle', {'minutes': 7})
    plan = vault.plan('restore', candidate, {})
    vault.apply_plan(plan['token'], 'restore')
    assert vault.idle_seconds == 420 and vault.data['idleMinutes'] == 7

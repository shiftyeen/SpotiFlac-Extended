"""tests/test_server_api.py — Unit tests for SpotiFLAC REST API server."""

from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi.testclient import TestClient

from SpotiFLAC.server.api import app, task_manager


@pytest.fixture
def client():
    return TestClient(app)


def test_health_endpoint(client):
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "online"
    assert "download_dir" in data


def test_create_and_get_task(client):
    with patch("SpotiFLAC.server.task_manager.TaskManager._run_download_task") as mock_run:
        # Mock background task execution
        mock_run.return_value = None

        response = client.post(
            "/api/v1/downloads",
            json={
                "url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
                "quality": "LOSSLESS",
                "services": ["tidal"],
            },
        )
        assert response.status_code == 200
        res_data = response.json()
        assert "task" in res_data
        task_id = res_data["task"]["task_id"]

        # Get task status
        get_res = client.get(f"/api/v1/tasks/{task_id}")
        assert get_res.status_code == 200
        task_data = get_res.json()
        assert task_data["task_id"] == task_id
        assert task_data["url"] == "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"


def test_list_tasks(client):
    response = client.get("/api/v1/tasks")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_installed_extensions_endpoint(client):
    response = client.get("/api/v1/extensions/installed")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_extensions_registry_endpoint(client):
    with patch(
        "SpotiFLAC.server.api.extension_manager.fetch_registry"
    ) as mock_fetch:
        mock_fetch.return_value = []
        response = client.get("/api/v1/extensions/registry")
        assert response.status_code == 200
        data = response.json()
        assert "extensions" in data
        assert data["total_extensions"] == 0

"""Offline WebSocket checks: uv run python -m unittest discover -s tests -p test_text_input.py."""
import asyncio
import os
import threading
import unittest
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch

os.environ.setdefault("GOOGLE_API_KEY", "offline-test-key")

from fastapi.testclient import TestClient
from app.main import app, client


class TextInputTest(unittest.TestCase):
    def setUp(self):
        self.ready = threading.Event()
        self.session = AsyncMock()

        async def receive():
            self.ready.set()
            await asyncio.Future()
            yield  # Keep the mocked upstream stream open.

        self.session.receive = receive

        @asynccontextmanager
        async def connect(**kwargs):
            yield self.session

        self.patch = patch.object(client.aio.live, "connect", connect)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_text_forwarding_validation_and_retry(self):
        with TestClient(app).websocket_connect("/ws/test/text?convo=true") as ws:
            ws.send_json({"glossary": []})
            self.assertTrue(self.ready.wait(5))
            for value in ["", "   ", 42, "x" * 10001]:
                ws.send_json({"type": "text", "text": value})
                self.assertIn("textError", ws.receive_json())
            self.session.send_realtime_input.assert_not_awaited()
            ws.send_json({"type": "text", "text": "  こんにちは\n世界  "})
            self.assertEqual(ws.receive_json(), {"textAccepted": "こんにちは\n世界"})
            self.session.send_realtime_input.assert_awaited_once_with(text="こんにちは\n世界")
            self.session.send_realtime_input.side_effect = RuntimeError("offline failure")
            ws.send_json({"type": "text", "text": "retry me"})
            self.assertIn("textError", ws.receive_json())
            self.session.send_realtime_input.side_effect = None
            ws.send_json({"type": "text", "text": "retry me"})
            self.assertEqual(ws.receive_json(), {"textAccepted": "retry me"})

    def test_simul_rejects_text(self):
        with TestClient(app).websocket_connect("/ws/test/text?simul=true") as ws:
            ws.send_json({"glossary": []})
            self.assertTrue(self.ready.wait(5))
            ws.send_json({"type": "text", "text": "Hello"})
            self.assertIn("textError", ws.receive_json())
            self.session.send_realtime_input.assert_not_awaited()

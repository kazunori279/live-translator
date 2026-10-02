"""Offline checks for the desktop's text-only translation endpoint."""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("GOOGLE_API_KEY", "offline-test-key")

from fastapi.testclient import TestClient
from google.genai import types
from app.main import app, client, TEXT_TRANSLATION_MODEL


def result(text="こんにちは", finish_reason="STOP"):
    return types.GenerateContentResponse(candidates=[types.Candidate(
        content=types.Content(parts=[types.Part(text=text)]),
        finish_reason=finish_reason,
    )])


class TextTranslationTest(unittest.TestCase):
    def setUp(self):
        self.http = TestClient(app)
        self.generator = AsyncMock(return_value=result())
        self.patch = patch.object(client.aio.models, "generate_content", self.generator)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_uses_flash_lite_text_only_and_target_language(self):
        with patch.object(client.aio.live, "connect") as live:
            response = self.http.post("/api/translate", json={"text": " Hello ", "source": "en", "target": "ja"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"text": "こんにちは", "model": TEXT_TRANSLATION_MODEL})
        live.assert_not_called()
        args = self.generator.call_args.kwargs
        self.assertEqual(args["model"], "gemini-3.5-flash-lite")
        self.assertEqual(args["contents"], "Hello")
        self.assertIn("Japanese", args["config"].system_instruction)
        self.assertEqual(args["config"].response_modalities, ["TEXT"])
        self.assertEqual(args["config"].thinking_config.thinking_level, "LOW")

    def test_invalid_input_does_not_call_model(self):
        for body in [{"text": ""}, {"text": " "}, {"text": 42}, {"text": "x" * 10001},
                     {"text": "hi", "target": "invalid"}, {"text": "hi", "source": "invalid"}]:
            with self.subTest(body_type=type(body.get("text"))):
                self.assertEqual(self.http.post("/api/translate", json=body).status_code, 422)
        self.generator.assert_not_awaited()

    def test_failures_timeouts_and_truncation(self):
        for failure, status in [(RuntimeError("sensitive upstream detail"), 502), (TimeoutError(), 504)]:
            self.generator.side_effect = failure
            response = self.http.post("/api/translate", json={"text": "Hello"})
            self.assertEqual(response.status_code, status)
            self.assertNotIn("sensitive upstream detail", response.text)
        self.generator.side_effect = None
        for output in [result(""), result("Partial", "MAX_TOKENS")]:
            self.generator.return_value = output
            self.assertEqual(self.http.post("/api/translate", json={"text": "Hello"}).status_code, 502)


if __name__ == "__main__":
    unittest.main()

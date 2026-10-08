import os

os.environ["MOCK_ANALYZE"] = "true"
os.environ["DATABASE_PATH"] = "data/test_skip_maps.db"
os.environ["OPENROUTER_API_KEY"] = ""
os.environ["GROQ_API_KEY"] = ""
os.environ["APP_KEY"] = "test-secret-key"

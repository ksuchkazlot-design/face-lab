---
name: pytest
description: Testing patterns with pytest, test client fixtures for FastAPI (TestClient/httpx), assertions, mocking, and automated test runners.
---

# Pytest Best Practices

## Core Principles
1. **Fixtures**: Use @pytest.fixture to setup test clients, database sessions, and sample input data.
2. **FastAPI Testing**: Use starlette.testclient.TestClient or httpx.AsyncClient for integration testing of API endpoints.
3. **Test Discovery**: Name test files test_*.py or *_test.py and test functions test_*.
4. **Assertions**: Use plain python assert statements with descriptive messages.

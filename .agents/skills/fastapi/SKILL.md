---
name: fastapi
description: Comprehensive guide and best practices for building high-performance FastAPI applications, async lifespan handlers, route structure, Pydantic v2 schemas, and dependency injection.
---

# FastAPI Best Practices & Guidelines

## Core Principles
1. **Async by Default**: Use async def for I/O bound endpoints. For CPU-bound tasks (OpenCV processing, heavy math), run in executor: await loop.run_in_executor(None, sync_func, *args).
2. **Lifespan Context Manager**: Use @asynccontextmanager async def lifespan(app: FastAPI) instead of deprecated startup/shutdown events.
3. **Pydantic Validation**: Use Pydantic models for request bodies and response models to ensure strict validation.
4. **Exception Handling**: Use HTTPException(status_code=..., detail=...) for clean REST errors.

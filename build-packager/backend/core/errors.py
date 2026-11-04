"""Errors shared by the API and the build runner."""
from fastapi import HTTPException


def bad(msg, code=400):
    raise HTTPException(code, msg)


class StepFailed(Exception):
    pass


class Skip(Exception):
    pass

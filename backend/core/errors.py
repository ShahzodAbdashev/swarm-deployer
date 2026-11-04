"""Errors shared by the API and the job runner."""
from fastapi import HTTPException


def bad(msg, code=400):
    raise HTTPException(code, msg)


class Fail(Exception):
    pass


class Skip(Exception):
    pass

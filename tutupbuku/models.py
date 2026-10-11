"""Small typed records and rule constants shared by the engine and exports."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
from typing import Any

RULE_VERSION = "2026-10-10.1"
DATE_WINDOW_DAYS = 7
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
SUPPORTED_ROOT_FILES = {"profile.md", "bank.csv", "bank_metadata.json", "sales.csv"}
SUPPORTED_RECEIPT_SUFFIXES = {".png", ".jpg", ".jpeg"}


@dataclass(frozen=True)
class BankRow:
    row_id: str
    date: date
    description: str
    amount_sen: int
    balance_sen: int


@dataclass(frozen=True)
class Candidate:
    id: str
    kind: str
    date: date
    name: str
    amount_sen: int
    source_path: str

    def as_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["date"] = self.date.isoformat()
        return value

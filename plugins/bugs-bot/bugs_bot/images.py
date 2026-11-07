"""Screenshots to reporters: the checks every image passes before anything is sent, and the copy of what was sent.

The agent posts screenshots its launcher hands it (``reply … --image <path>``, ``post … --image``). Every
image is checked first — all of them, before the first byte goes out — and each one sent is copied
beside the report (``sent/<reply n>-<k>.<ext>``), so ``show`` and the handover note know what the
person saw.
"""

from __future__ import annotations

from pathlib import Path

from bugs_bot.channel import Channel, ChatId, ImagesNotSent, Mention, MessageId
from bugs_bot.errors import BugsError

MAX_IMAGES = 10
MAX_BYTES = 10 * 1024 * 1024
# The formats both platforms show inline, told by their first bytes (a name proves nothing).
_MAGIC = ((b"\x89PNG\r\n\x1a\n", ".png"), (b"\xff\xd8\xff", ".jpg"))
_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}


def extension_of(head: bytes) -> str | None:
    """Return the extension of an image by its first bytes (``.png``, ``.jpg``, ``.webp``), ``None`` for anything else."""
    for magic, ext in _MAGIC:
        if head.startswith(magic):
            return ext
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    return None


def wire_file(path: Path, rank: int) -> tuple[str, bytes, str]:
    """Return what a channel uploads for the ``rank``-th image (1-based): ``(name, bytes, content type)``.

    The name is a neutral ``image-<k>.<ext>``: the file's own name may tell a local detail, and the group sees it.

    Raises:
        BugsError: If the file can no longer be read, or is no longer an image (changed since ``check_images``).
    """
    try:
        data = path.read_bytes()
    except OSError as exc:
        raise BugsError(f"{path}: cannot read: {exc.strerror or exc.__class__.__name__}") from None
    ext = extension_of(data[:12])
    if ext is None:
        raise BugsError(f"{path}: no longer a PNG, JPEG or WebP image")
    return f"image-{rank}{ext}", data, _TYPES[ext]


def _problem(path: Path) -> str | None:
    """Return why ``path`` cannot be sent, ``None`` when it can."""
    if not path.is_file():
        return "no such file"
    if path.stat().st_size > MAX_BYTES:
        return f"over {MAX_BYTES // (1024 * 1024)} MB"
    with path.open("rb") as handle:
        if extension_of(handle.read(12)) is None:
            return "not a PNG, JPEG or WebP image"
    return None


def check_images(paths: list[str]) -> list[Path]:
    """Check the images to send: 1 to ``MAX_IMAGES`` files, each PNG, JPEG or WebP, ``MAX_BYTES`` at most.

    Args:
        paths: The paths as given on the command line.

    Returns:
        The absolute paths, in the order given.

    Raises:
        BugsError: Naming every image refused and why. Nothing has been sent.
    """
    if not 1 <= len(paths) <= MAX_IMAGES:
        raise BugsError(f"{len(paths)} images: 1 to at most {MAX_IMAGES} images per message")
    resolved = [Path(path).expanduser().resolve() for path in paths]
    refused = [f"{path}: {why}" for path in resolved if (why := _problem(path))]
    if refused:
        raise BugsError("image refused, nothing sent: " + "; ".join(refused))
    return resolved


def post(
    channel: Channel, chat_id: ChatId, text: str, paths: list[Path], reply_to: MessageId | None = None, mention: Mention | None = None
) -> tuple[dict, list[tuple[str, bytes, str]], ImagesNotSent | None]:
    """Send ``text`` alone, or with ``paths`` (checked already) when there are some.

    Returns:
        ``(what was posted, images sent, failure)``. What was posted is ``{"text", "message_id"}`` for a
        message; with images, ``message_ids`` lists every message (the first is ``message_id``) and, on a
        platform that keeps files apart, ``file_ids`` names them — no ``message_id`` when no message is
        known. The images are ``(name, bytes, content type)`` as sent. The failure is the images lost
        after their text went out alone — the caller records what was posted, then raises it.

    Raises:
        BugsError: Nothing was posted.
    """
    if not paths:
        sent = channel.send(chat_id, text, reply_to, mention)
        return {"text": sent["text"], "message_id": sent["message_id"]}, [], None
    try:
        shown = channel.send_images(chat_id, text, paths, reply_to, mention)
    except ImagesNotSent as exc:
        return {"text": exc.sent["text"], "message_id": exc.sent["message_id"]}, [], exc
    posted: dict = {"text": shown.text}
    if shown.message_ids:
        posted |= {"message_id": shown.message_ids[0], "message_ids": shown.message_ids}
    if shown.file_ids:
        posted["file_ids"] = shown.file_ids
    return posted, shown.files, None


def record_sent(report_dir: Path, reply_number: int, files: list[tuple[str, bytes, str]]) -> list[str]:
    """Write the images sent with reply ``reply_number`` into ``<report_dir>/sent/<n>-<k>.<ext>``: the bytes sent.

    Returns:
        Their names relative to the report's directory, in order, as the reply records them.
    """
    (report_dir / "sent").mkdir(exist_ok=True)
    names = []
    for rank, (name, data, _) in enumerate(files, 1):
        names.append(f"sent/{reply_number}-{rank}{Path(name).suffix}")
        (report_dir / names[-1]).write_bytes(data)
    return names

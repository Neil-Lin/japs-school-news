"""Replace published files one by one and restore every replaced file if any replacement fails."""
import os
from pathlib import Path


def replace_files(stage, directory, previous):
    """Move stage/name over directory/name in the order of `previous`, which maps each name to its old bytes or None."""
    stage, directory = Path(stage), Path(directory)
    replaced = []
    try:
        for name in previous:
            (directory / name).parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / name, directory / name)
            replaced.append(name)
    except OSError:
        for index, name in enumerate(reversed(replaced)):
            if previous[name] is None:
                (directory / name).unlink(missing_ok=True)
            else:
                backup = stage / f"rollback-{index}"
                backup.write_bytes(previous[name])
                os.replace(backup, directory / name)
        raise

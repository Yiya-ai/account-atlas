import argparse
from pathlib import Path
import portalocker
from waitress import serve
from backend.app import create_app
from backend.deployment import PublicDeployment

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Account Atlas local vault")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).parent / "data")
    parser.add_argument("--public-config", type=Path, help="Explicit HTTPS proxy and offline city-gate configuration")
    args = parser.parse_args()
    deployment = PublicDeployment.from_file(args.public_config) if args.public_config else None
    args.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        with portalocker.Lock(str(args.data_dir / ".instance.lock"), timeout=0):
            print(f"Account Atlas: http://127.0.0.1:{args.port}", flush=True)
            serve(create_app(args.data_dir, port=args.port, deployment=deployment), host="127.0.0.1", port=args.port, threads=4,
                  max_request_body_size=16 * 1024 * 1024)
    except portalocker.exceptions.LockException:
        raise SystemExit("This vault is already open in another process.")

#!/usr/bin/env python3
import argparse
import getpass
from pathlib import Path

import pg8000.native


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--user", default="postgres")
    parser.add_argument("--database", default="postgres")
    parser.add_argument("--port", type=int, default=5432)
    parser.add_argument("--sql", default="supabase-schema.sql")
    args = parser.parse_args()

    password = getpass.getpass("Database password: ")
    sql = Path(args.sql).read_text(encoding="utf-8")

    conn = pg8000.native.Connection(
        user=args.user,
        password=password,
        host=args.host,
        port=args.port,
        database=args.database,
        ssl_context=True,
    )
    try:
        conn.run(sql)
    finally:
        conn.close()

    print("Supabase schema initialized successfully.")


if __name__ == "__main__":
    main()

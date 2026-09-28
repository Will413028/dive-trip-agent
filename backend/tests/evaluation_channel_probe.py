"""Synthetic child for the real inherited Node duplex contract; no DB or SDK."""

import asyncio
import socket

from dive_trip.platform.evaluation_channel import EvaluationChannel


async def main():
    reader, writer = await asyncio.open_connection(sock=socket.socket(fileno=3))
    channel = EvaluationChannel(reader, writer)
    cleaned = False

    async def handler(command):
        nonlocal cleaned
        if command.operation == "audit":
            return {"cleaned": cleaned}
        try:
            value = await channel.load_credential()
            assert value == "synthetic-not-a-real-key"
            if command.input.get("wait"):
                await asyncio.sleep(60)
            return {"synthetic": True}
        finally:
            await asyncio.sleep(0.05)
            cleaned = True

    await channel.serve(handler)


if __name__ == "__main__":
    asyncio.run(main())

import os

import pytest
from psycopg.conninfo import conninfo_to_dict

from dive_trip.bootstrap.hosted_config import HostedFixtureConfig


@pytest.fixture
def files(tmp_path):
    paths = [tmp_path / "database", tmp_path / "ingress"]
    for path, value in zip(paths, ("a" * 64, "b" * 64), strict=True):
        path.write_text(value)
        path.chmod(0o600)
    return paths


def test_dedicated_database_and_secret_redaction(files):
    config = HostedFixtureConfig.load("https://demo.example.com", *files, {})
    values = conninfo_to_dict(config.database_conninfo())
    assert (values["host"], values["dbname"], values["user"]) == (
        "db",
        "dive_trip_demo",
        "dive_trip_app",
    )
    assert values["passfile"] == "/dev/null"
    assert "a" * 64 not in repr(config)
    assert "b" * 64 not in repr(config)


@pytest.mark.parametrize(
    "name",
    [
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "CLOUDFLARE_API_TOKEN",
        "OPENROUTER_API_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "DIVE_LOCAL_LIVE",
        "DIVE_TRIP_CLOUDFLARE_PROBE_8_AUTHORIZATION",
        "PGSERVICE",
        "PGPASSWORD",
        "DATABASE_URL",
        "COMPOSE_PROJECT_NAME",
    ],
)
def test_ambient_or_generation_config_rejected_before_secret_read(name, tmp_path):
    with pytest.raises(ValueError, match="AMBIENT_CONFIG_DISABLED"):
        HostedFixtureConfig.load(
            "https://demo.example.com",
            tmp_path / "absent",
            tmp_path / "absent",
            {name: ""},
        )


@pytest.mark.parametrize(
    "origin",
    [
        "http://demo.example.com",
        "https://demo.example.com/",
        "https://u:p@demo.example.com",
        "https://demo.example.com:443",
        "https://demo.example.com/path",
        "https://demo.example.com?query",
        "https://demo.example.com#fragment",
        "https://localhost",
        "https://127.0.0.1",
        "https://DEMO.example.com",
    ],
)
def test_noncanonical_public_origin_rejected_before_secrets(origin, tmp_path):
    with pytest.raises(ValueError, match="HTTPS_ORIGIN_REQUIRED"):
        HostedFixtureConfig.load(origin, tmp_path / "absent", tmp_path / "absent", {})


@pytest.mark.parametrize(
    "mutation", ["permission", "symlink", "hardlink", "oversize", "newline", "same"]
)
def test_secret_boundaries(files, tmp_path, mutation):
    if mutation == "permission":
        files[0].chmod(0o644)
    elif mutation == "symlink":
        link = tmp_path / "link"
        link.symlink_to(files[0])
        files[0] = link
    elif mutation == "hardlink":
        os.link(files[0], tmp_path / "link")
    elif mutation == "oversize":
        files[0].write_text("a" * 65)
    elif mutation == "newline":
        files[0].write_text("a" * 63 + "\n")
    else:
        files[1].write_text("a" * 64)
    with pytest.raises((ValueError, OSError)):
        HostedFixtureConfig.load("https://demo.example.com", *files, {})

"""PWA / Web Push smoke tests.

Verifies the manifest + icon endpoints return sensible content and
the push preferences round-trip cleanly. Real end-to-end push
delivery is exercised manually on a real device (the test browser
above has no push service in headless mode)."""
import pytest


@pytest.mark.asyncio
async def test_manifest_defaults_to_platform_brand():
    from routes.pwa import _brand_for_host
    b = await _brand_for_host("smartbookssoftware.ai")
    assert b["brand_key"] == "platform"
    assert b["name"] == "SmartBooks"
    assert b["theme_color"].startswith("#")


@pytest.mark.asyncio
async def test_icon_renderer_produces_png():
    """PIL fallback should always produce a valid PNG so the browser
    install dialog never 404s during onboarding."""
    from routes.pwa import _render_icon, _PIL_OK
    if not _PIL_OK:
        pytest.skip("PIL not installed")
    img = _render_icon(
        {"theme_color": "#0891b2", "initial": "A"},
        size=192, maskable=False,
    )
    # A 192x192 RGB image.
    assert img.size == (192, 192)


def test_hex_to_rgb_edges():
    from routes.pwa import _hex_to_rgb
    assert _hex_to_rgb("#000") == (0, 0, 0)
    assert _hex_to_rgb("#ffffff") == (255, 255, 255)
    assert _hex_to_rgb("0891b2") == (8, 145, 178)
    # Malformed input → cyan fallback, not a crash.
    assert _hex_to_rgb("garbage") == (8, 145, 178)


@pytest.mark.asyncio
async def test_push_send_no_subscriptions_returns_zero():
    """`send_web_push` must silently no-op when the user has zero
    devices installed. This is the hot path for every `notify()` call
    on a user who hasn't installed the PWA yet — must not raise."""
    from push import send_web_push
    delivered = await send_web_push(
        "user_that_does_not_exist",
        title="test", body="", url="/", category="system",
    )
    assert delivered == 0

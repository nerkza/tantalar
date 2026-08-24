/** Shared sign-in helper for e2e specs. */
import { expect, test } from "@playwright/test";

const USER = "admin";
const PASS = "password-admin-1";

/** Sign in through the UI and land on Home (product shell default). */
export async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("home-page")).toBeVisible();
}

export { test };

/**
 * Safely fill a text input rendered inside the admin page.
 *
 * Playwright's fill() and keyboard.type() hang (CDP insertText/keyDown
 * timeout) on Mantine inputs rendered inside the admin page — rawKeyDown
 * works but the compositor pipeline blocks text-insertion CDP calls.
 * Raw DOM inputs and the sign-in page are unaffected.
 *
 * This helper focuses the element, then sets the HTMLInputElement value
 * via the native setter and dispatches an `input` event so React controlled
 * inputs pick up the change.
 */
export async function fillSafely(
  locator: import("@playwright/test").Locator,
  value: string,
): Promise<void> {
  await locator.focus({ timeout: 10_000 });
  await locator.evaluate(
    (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!;
      setter.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}
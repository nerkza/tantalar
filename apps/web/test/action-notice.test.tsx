import React, { StrictMode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ActionNotice, useActionFeedback } from "../src/components/ActionNotice";
import { show } from "../src/notifications";

vi.mock("../src/notifications", () => ({ show: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("notifies once per action, including identical repeated failures, with explicit severity", () => {
  function Feedback() {
    const [message, setMessage, severity, revision] = useActionFeedback();
    return <><button onClick={() => setMessage("Already saved, but dispatch failed.", "error")}>Retry</button>
      <ActionNotice message={message} title="Download failed" severity={severity} revision={revision} /></>;
  }
  const view = render(<StrictMode><Feedback /></StrictMode>);
  expect(show).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(show).toHaveBeenCalledTimes(1);
  expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ severity: "error", title: "Download failed" }));
  view.rerender(<StrictMode><Feedback /></StrictMode>);
  expect(show).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(show).toHaveBeenCalledTimes(2);
});

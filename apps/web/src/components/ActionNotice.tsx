import { useCallback, useEffect, useId, useRef, useState, type SetStateAction } from "react";
import { show, type NoticeSeverity } from "../notifications";

/** Keep severity explicit at the action's success or failure branch. */
export function useActionFeedback() {
  const [feedback, setFeedback] = useState<{ message: string | null; severity: NoticeSeverity; revision: number }>({ message: null, severity: "success", revision: 0 });
  const setMessage = useCallback((message: SetStateAction<string | null>, severity: NoticeSeverity = "success") => {
    setFeedback(previous => ({ message: typeof message === "function" ? message(previous.message) : message, severity, revision: previous.revision + 1 }));
  }, []);
  return [feedback.message, setMessage, feedback.severity, feedback.revision] as const;
}

/** Send action feedback through the application queue without shifting page content. */
export function ActionNotice({ message, title, severity = "success", revision = 0 }: {
  message: string | null | undefined;
  title: string;
  severity?: NoticeSeverity;
  revision?: number;
}) {
  const id = useId();
  const previous = useRef("");
  useEffect(() => {
    const signature = message ? `${revision}:${severity}:${title}:${message}` : "";
    if (signature && signature !== previous.current) show({ key: `action:${id}`, severity, title, message: message! });
    previous.current = signature;
  }, [id, message, severity, title, revision]);
  return null;
}

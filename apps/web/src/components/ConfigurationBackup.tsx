import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, FileInput, Group, NumberInput, Stack, Switch, Text, TextInput, Title } from "@mantine/core";
import { api } from "../api";
import { ActionNotice, useActionFeedback } from "./ActionNotice";
import { formatDateTime } from "../date";
import "./configuration-backup.css";

const KEY = ["configuration-backup"];
const CONSEQUENCE = "Import replaces settings, credentials, accounts and database state at restart. Media files are excluded. Use a trusted file from the same Tantalar version. Sign in with an account from that file after restart. Host configuration and environment overrides remain active.";

export function ConfigurationImport() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: KEY, queryFn: api.backupSettings, retry: false });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const isPending = pending || status.data?.pendingImport;
  const run = async (cancel = false) => {
    if (!cancel && (!file || !window.confirm(CONSEQUENCE))) return;
    setBusy(true); setError(null);
    try {
      if (cancel) { await api.cancelConfigurationImport(); setPending(false); }
      else {
        if (file!.size > 256 * 1024 * 1024) throw new Error("Configuration file exceeds 256 MiB.");
        let value: unknown;
        try { value = JSON.parse(await file!.text()); } catch { throw new Error("Select a valid Tantalar configuration JSON file."); }
        await api.importConfiguration(value);
        setPending(true); setFile(null);
      }
      await qc.invalidateQueries({ queryKey: KEY });
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <Stack gap="sm">
    <Title order={2}>Import configuration</Title>
    <Text size="sm">{CONSEQUENCE}</Text>
    {status.isPending ? <Text aria-busy="true">Loading import status…</Text> : null}
    {status.isError ? <Alert title="Import status unavailable"><Text>{(status.error as Error).message}</Text><Button variant="default" onClick={() => void status.refetch()}>Retry</Button></Alert> : null}
    {status.data?.supported === false ? <Text role="note">Configuration files require SQLite storage.</Text> : null}
    {isPending ? <Alert title="Restart required" role="status">
      <Text>Import validated and pending. Restart Tantalar, then sign in with an administrator account from the imported file.</Text>
      <Button variant="default" loading={busy} onClick={() => void run(true)}>Cancel pending import</Button>
    </Alert> : <>
      <FileInput label="Configuration file" accept=".json,application/json" value={file} onChange={setFile} disabled={busy || !status.data?.supported} clearable />
      <Group><Button disabled={!file || !status.data?.supported} loading={busy} onClick={() => void run()}>Validate and import</Button></Group>
    </>}
    {error ? <Alert role="alert" title="Import failed">{error}</Alert> : null}
  </Stack>;
}

export function ConfigurationBackup() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: KEY, queryFn: api.backupSettings, retry: false });
  const [directory, setDirectory] = useState("");
  const [retention, setRetention] = useState<number | string>(7);
  const [schedule, setSchedule] = useState("daily 02:00");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [restorePath, setRestorePath] = useState("");
  const [note, setNote, severity, revision] = useActionFeedback();
  useEffect(() => {
    if (!settings.data) return;
    setDirectory(settings.data.directory); setRetention(settings.data.retention);
    setSchedule(settings.data.schedule); setEnabled(settings.data.enabled);
  }, [settings.data]);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try { setNote(await action(), "success"); await qc.invalidateQueries({ queryKey: KEY }); }
    catch (cause) { setNote((cause as Error).message, "error"); }
    finally { setBusy(false); }
  };
  return <Stack gap="lg" className="tantalar-configuration-backup">
    <Stack gap="sm">
      <Title order={2}>Save and export</Title>
      <Text size="sm">Files contain credentials and all database state. Store them securely. Media files, plugin binaries and external services are excluded.</Text>
      <Group>
        <Button disabled={busy || !settings.data?.supported} onClick={() => void run(async () => `Configuration saved to ${(await api.backup()).path}.`)}>Save configuration on server</Button>
        <Button variant="default" disabled={busy || !settings.data?.supported} onClick={() => void run(async () => {
          const file = await api.exportConfiguration();
          const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
          const link = document.createElement("a");
          link.href = url; link.download = `tantalar-configuration-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.append(link); link.click(); link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          return "Configuration exported.";
        })}>Export configuration file</Button>
      </Group>
    </Stack>
    <ConfigurationImport />
    <Stack gap="sm">
      <Title order={2}>Automatic backups</Title>
      {settings.isPending ? <Text aria-busy="true">Loading backup settings…</Text> : null}
      {settings.isError ? <Alert role="alert" title="Backup settings unavailable"><Text>{(settings.error as Error).message}</Text><Button variant="default" onClick={() => void settings.refetch()}>Retry</Button></Alert> : null}
      {settings.data?.supported ? <form onSubmit={event => { event.preventDefault(); void run(async () => {
        await api.updateBackupSettings({ directory, retention: Number(retention), schedule, enabled });
        return "Backup settings saved.";
      }); }}><Stack gap="sm">
        <Switch label="Enable automatic backups" checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} disabled={busy} />
        <TextInput label="Schedule (UTC)" description="daily HH:MM or every 24h, every 60m. Daily backups default to 02:00 UTC." value={schedule} onChange={event => setSchedule(event.currentTarget.value)} required disabled={busy} />
        <TextInput label="Backup directory" value={directory} onChange={event => setDirectory(event.currentTarget.value)} required disabled={busy} />
        <NumberInput label="Automatic backups to retain" description="0 keeps all automatic backups. Manual and safety backups are never removed automatically." value={retention} onChange={setRetention} min={0} max={3650} allowDecimal={false} disabled={busy} />
        <Text size="sm">Next backup (local time): {settings.data.nextRunAt ? formatDateTime(settings.data.nextRunAt) : "Disabled"}</Text>
        {settings.data.latestRun ? <Text size="sm">Last run: {settings.data.latestRun.state}. {settings.data.latestRun.outcome ?? settings.data.latestRun.error}</Text> : <Text size="sm">No backup runs yet. Save a configuration now or wait for the next scheduled run.</Text>}
        <Group><Button type="submit" loading={busy} disabled={retention === ""}>Save backup settings</Button></Group>
      </Stack></form> : null}
    </Stack>
    <details><summary>Restore a server backup</summary><Stack gap="sm">
      <TextInput label="Server backup path" value={restorePath} onChange={event => setRestorePath(event.currentTarget.value)} placeholder="/data/backups/tantalar-config-….json" />
      <Group><Button variant="default" disabled={busy || !restorePath.trim()} onClick={() => {
        if (window.confirm(CONSEQUENCE)) void run(async () => (await api.restore(restorePath.trim())).note);
      }}>Validate and restore</Button></Group>
    </Stack></details>
    <ActionNotice message={note} severity={severity} revision={revision} title="Configuration and backups" />
  </Stack>;
}

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Group, Modal, NumberInput, Select, Stack, Tabs, Text, TextInput, Title } from "@mantine/core";
import type { ColumnDef } from "@tanstack/react-table";
import { api, type JobRun, type ScheduledJob } from "../api";
import { DenseGrid, initialExplorerQuery, type ExplorerQuery } from "../admin/DenseGrid";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { FileMaintenancePage } from "./FileMaintenancePage";

const date = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);
function parameters(q: ExplorerQuery, jobKey?: string) {
  return "?" + new URLSearchParams({ search: q.search, sort: q.sort, desc: String(q.desc), page: String(q.page), pageSize: String(q.pageSize),
    ...Object.fromEntries(Object.entries(q.filters).map(([k, v]) => [`filter_${k}`, v])), ...(jobKey ? { jobKey } : {}) });
}

function ScheduleEditor({ job, close, save, busy }: { job: ScheduledJob; close: () => void; save: (schedule: string) => void; busy: boolean }) {
  const every = /^every (\d+)([smh])$/.exec(job.schedule);
  const [mode, setMode] = useState(every ? "interval" : "daily");
  const [amount, setAmount] = useState<number | string>(Number(every?.[1] ?? 1));
  const [unit, setUnit] = useState(every?.[2] ?? "h");
  const [time, setTime] = useState(job.schedule.startsWith("daily ") ? job.schedule.slice(6) : "03:00");
  return <Modal opened onClose={close} title={`Schedule: ${job.name}`} closeButtonProps={{ "aria-label": "Close" }} centered>
    <form onSubmit={event => { event.preventDefault(); save(mode === "daily" ? `daily ${time}` : `every ${amount}${unit}`); }}>
      <Stack>
        <Select label="Frequency" value={mode} onChange={v => setMode(v ?? "interval")} data={[{ value: "interval", label: "Interval" }, { value: "daily", label: "Daily" }]} />
        {mode === "interval" ? <Group grow align="end"><NumberInput label="Every" min={1} max={31536000} allowDecimal={false} required value={amount} onChange={setAmount} /><Select label="Unit" value={unit} onChange={v => setUnit(v ?? "h")} data={[{ value: "s", label: "Seconds" }, { value: "m", label: "Minutes" }, { value: "h", label: "Hours" }]} /></Group>
          : <><TextInput type="time" label="Time (UTC)" required value={time} onChange={e => setTime(e.currentTarget.value)} /><Text size="sm" c="dimmed">Daily schedules stay fixed in UTC. Local time changes with daylight saving.</Text></>}
        <Group justify="flex-end"><Button variant="default" onClick={close}>Cancel</Button><Button type="submit" loading={busy}>Save schedule</Button></Group>
      </Stack>
    </form>
  </Modal>;
}

export function JobsPage() {
  const client = useQueryClient();
  const [tab, setTab] = useState<string | null>("schedules");
  const [jobQuery, setJobQuery] = useState(initialExplorerQuery);
  const [runQuery, setRunQuery] = useState(initialExplorerQuery);
  const [selected, setSelected] = useState<ScheduledJob | null>(null);
  const [editing, setEditing] = useState<ScheduledJob | null>(null);
  const [inspect, setInspect] = useState<JobRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage, severity, revision] = useActionFeedback();
  const jobs = useQuery({ queryKey: ["jobs", "schedules", jobQuery], queryFn: () => api.jobs(parameters(jobQuery)), refetchInterval: 5000 });
  const runs = useQuery({ queryKey: ["jobs", "runs", runQuery, selected?.jobKey], queryFn: () => api.jobRuns(parameters(runQuery, selected?.jobKey)), enabled: tab === "runs", refetchInterval: 3000 });
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    try { await work(); setMessage(success); await client.invalidateQueries({ queryKey: ["jobs"] }); setEditing(null); }
    catch (error) { setMessage((error as Error).message, "error"); }
    finally { setBusy(false); }
  }
  const scheduleColumns: ColumnDef<ScheduledJob, unknown>[] = [
    { id: "name", header: "Job", accessorKey: "name", size: 270, enableHiding: false },
    { id: "scope", header: "Scope", accessorKey: "scope", size: 200 },
    { id: "state", header: "State", accessorKey: "state", size: 110, cell: c => label(String(c.getValue())) },
    { id: "schedule", header: "Schedule", accessorKey: "schedule", size: 130, cell: ({ row }) => row.original.schedule.replace(/^every /, "Every ").replace(/^daily /, "Daily ") + (row.original.schedule.startsWith("daily") ? " UTC" : "") },
    { id: "nextRunAt", header: "Next run", accessorKey: "nextRunAt", size: 180, cell: c => date(c.getValue() as string | null) },
    { id: "outcome", header: "Last result", accessorFn: j => j.latestRun?.error ?? j.latestRun?.outcome ?? "Not run", size: 300 },
    { id: "actions", header: "Actions", enableSorting: false, size: 330, cell: ({ row: { original: job } }) => <Group gap={4} wrap="wrap">
      {!job.manualOnly && <Button size="compact-xs" variant="default" disabled={busy || !job.registered || !!job.lockedAt} onClick={() => void act(() => api.runJob(job.jobKey), "Job started. Check Runs for the result.")}>Run now</Button>}
      <Button size="compact-xs" variant="subtle" onClick={() => { setSelected(job); setTab("runs"); }}>History</Button>
      {job.manualOnly ? <Text size="xs">Preview required</Text> : job.protected ? <Text size="xs">System schedule</Text> : <>
        <Button size="compact-xs" variant="subtle" disabled={busy || !job.registered} onClick={() => setEditing(job)}>Edit</Button>
        <Button size="compact-xs" variant="subtle" disabled={busy || !job.registered} onClick={() => void act(() => api.updateJob(job.jobKey, { enabled: !job.enabled }), job.enabled ? "Schedule disabled. Running work continues." : "Schedule enabled.")}>{job.enabled ? "Disable" : "Enable"}</Button>
        {job.schedule !== job.defaultSchedule && <Button size="compact-xs" variant="subtle" disabled={busy || !job.registered} onClick={() => void act(() => api.updateJob(job.jobKey, { restoreDefault: true }), "Default schedule restored.")}>Restore default</Button>}
      </>}
    </Group> },
  ];
  const runColumns: ColumnDef<JobRun, unknown>[] = [
    { id: "jobKey", header: "Job", accessorKey: "name", size: 270, enableHiding: false },
    { id: "startedAt", header: "Started", accessorKey: "startedAt", size: 185, cell: c => date(c.getValue() as string) },
    { id: "trigger", header: "Trigger", accessorKey: "trigger", size: 100, cell: c => label(String(c.getValue())) },
    { id: "state", header: "State", accessorKey: "state", size: 110, cell: c => label(String(c.getValue())) },
    { id: "durationMs", header: "Duration", accessorKey: "durationMs", size: 100, cell: c => c.getValue() === null ? "—" : `${(Number(c.getValue()) / 1000).toFixed(1)} s` },
    { id: "outcome", header: "Outcome", accessorFn: r => r.error ?? r.outcome ?? "Running", size: 340 },
    { id: "actions", header: "Actions", enableSorting: false, size: 240, cell: ({ row: { original: run } }) => <Group gap={4}>
      <Button size="compact-xs" variant="subtle" onClick={() => setInspect(run)}>Details</Button>
      {run.traceAvailable !== false && <Button component="a" href={`#/admin/audit/trace?correlationId=${encodeURIComponent(run.id)}`} size="compact-xs" variant="subtle">Open Trace</Button>}
      {["failed", "partial", "blocked", "interrupted"].includes(run.state) && <Button size="compact-xs" variant="default" disabled={busy} onClick={() => void act(() => api.retryJob(run.id), "Retry started. Check Runs for the result.")}>Retry</Button>}
    </Group> },
  ];
  let details: { counts?: Record<string, number>; reasons?: string[] } = {};
  try { details = JSON.parse(inspect?.details ?? "{}") ?? {}; } catch { /* Historical rows can lack structured details. */ }
  return <Stack gap="md">
    <Group justify="flex-end"><Button component="a" href="#/admin/acquisition/quality" variant="subtle" size="compact-sm">Quality management</Button></Group>
    <ActionNotice message={message} title="Jobs" severity={severity} revision={revision} />
    <Tabs value={tab} onChange={setTab} keepMounted={false}>
      <Tabs.List aria-label="Jobs views"><Tabs.Tab value="schedules">Schedules</Tabs.Tab><Tabs.Tab value="runs">Runs</Tabs.Tab><Tabs.Tab value="files">File maintenance</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="files" pt="md"><FileMaintenancePage /></Tabs.Panel>
      <Tabs.Panel value="schedules" pt="md">
        {jobs.isError ? <Alert color="red" title="Jobs unavailable">{(jobs.error as Error).message}<Button variant="subtle" onClick={() => void jobs.refetch()}>Retry</Button></Alert> : <DenseGrid columns={scheduleColumns} data={jobs.data?.items ?? []} total={jobs.data?.total ?? 0} loading={jobs.isPending} testId="jobs-schedules" ariaLabel="Job schedules" onQueryChange={setJobQuery} emptyMessage="No jobs match these filters." filters={[{ id: "state", label: "State", options: ["enabled", "disabled", "running", "unavailable"].map(value => ({ value, label: label(value) })) }]} />}
      </Tabs.Panel>
      <Tabs.Panel value="runs" pt="md">
        {selected && <Group mb="sm"><Text>{selected.name} — {selected.scope}</Text><Button variant="subtle" size="compact-sm" onClick={() => setSelected(null)}>Show all jobs</Button></Group>}
        {runs.isError ? <Alert color="red" title="Run history unavailable">{(runs.error as Error).message}<Button variant="subtle" onClick={() => void runs.refetch()}>Retry</Button></Alert> : <DenseGrid key={selected?.jobKey ?? "all"} columns={runColumns} data={runs.data?.runs ?? []} total={runs.data?.total ?? 0} loading={runs.isPending} testId="jobs-runs" ariaLabel="Job runs" onQueryChange={setRunQuery} emptyMessage="No runs match these filters." filters={[{ id: "state", label: "State", options: ["running", "succeeded", "failed", "partial", "blocked", "skipped", "interrupted"].map(value => ({ value, label: label(value) })) }, { id: "trigger", label: "Trigger", options: ["scheduled", "manual", "retry"].map(value => ({ value, label: label(value) })) }]} />}
      </Tabs.Panel>
    </Tabs>
    {editing && <ScheduleEditor key={editing.jobKey} job={editing} close={() => setEditing(null)} busy={busy} save={schedule => void act(() => api.updateJob(editing.jobKey, { schedule }), "Schedule saved.")} />}
    <Modal opened={!!inspect} onClose={() => setInspect(null)} title={inspect?.name ?? "Run details"} closeButtonProps={{ "aria-label": "Close" }} size="lg">
      {inspect && <Stack gap="sm"><Text>{label(inspect.state)} · {label(inspect.trigger)}</Text><Text>{inspect.error ?? inspect.outcome ?? "Running"}</Text>
        <Text size="sm">Started: {date(inspect.startedAt)}<br />Finished: {date(inspect.finishedAt)}</Text>
        {Object.keys(details.counts ?? {}).length > 0 && <><Title order={3}>Result counts</Title>{Object.entries(details.counts!).map(([key, value]) => <Text size="sm" key={key}>{label(key)}: {value}</Text>)}</>}
        {(details.reasons?.length ?? 0) > 0 && <><Title order={3}>Reasons</Title>{details.reasons!.map((reason, index) => <Text key={index} size="sm">{reason}</Text>)}</>}
        {inspect.retryOf && <Text size="sm">Retry of run {inspect.retryOf}</Text>}
      </Stack>}
    </Modal>
  </Stack>;
}

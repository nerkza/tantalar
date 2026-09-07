import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Group, Modal, NumberInput, Select, Stack, Table, Tabs, Text, Title } from "@mantine/core";
import { api, type QualityConfiguration } from "../api";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { metadataLabel } from "../state-label";
import { IconLine3Horizontal } from "symbols-react";
import "./quality.css";

const sizePresetsGb = [0, 0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 40, 60, 80, 100];
const sizeFields = { min: "Minimum", preferred: "Preferred", max: "Maximum" } as const;
function SizeSlider({ value, lower, upper, runtime, field, name, change }: {
  value: number | null; lower: number; upper: number | null; runtime: number;
  field: keyof typeof sizeFields; name: string; change: (value: number | null) => void;
}) {
  const stopsId = useId();
  // Store MB/min unchanged; GB is a reference-runtime view, with exact existing values retained as stops.
  const factor = runtime * 1048576 / 1_000_000_000;
  const finite = [...new Set([...sizePresetsGb.map(gb => gb / factor), ...(value === null ? [] : [value]), lower, ...(upper === null ? [] : [upper])])]
    .filter(n => n >= lower && (upper === null || n <= upper)).sort((a, b) => a - b);
  const stops: Array<number | null> = field === "min" ? finite : [...finite, null];
  const format = (n: number | null) => n === null ? field === "max" ? "Unlimited" : "No target" : `${Number((n * factor).toFixed(2))} GB`;
  const selected = stops.indexOf(value);
  return <Stack gap="xs" className="quality-size-slider">
    <Group justify="space-between" gap="xs"><Text size="xs" c="dimmed">{sizeFields[field]}</Text><Text size="sm" fw={500} style={{ fontVariantNumeric: "tabular-nums" }}>{format(value)}</Text></Group>
    <input type="range" className="quality-size-range" aria-label={name} aria-valuetext={format(value)} min={0} max={Math.max(1, stops.length - 1)} step={1} value={Math.max(0, selected)}
      disabled={stops.length < 2} list={stopsId} onChange={event => change(stops[Number(event.currentTarget.value)] ?? null)} />
    <datalist id={stopsId}>{stops.map((n, index) => <option key={index} value={index} label={format(n)} />)}</datalist>
  </Stack>;
}

function QualityOrder({ qualities, cutoff, busy, change }: { qualities: readonly string[]; cutoff: string; busy: boolean; change: (qualities: string[]) => void }) {
  const [drag, setDrag] = useState<{ quality: string; target: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const move = (quality: string, target: string) => {
    const from = qualities.indexOf(quality), to = qualities.indexOf(target);
    if (busy || from < 0 || to < 0 || from === to) return;
    const order = [...qualities]; order.splice(from, 1); order.splice(to, 0, quality);
    change(order); setAnnouncement(`${quality} moved to position ${to + 1} of ${order.length}.`);
  };
  return <Stack gap="xs">
    <Text size="sm" fw={600}>Allowed qualities · best first</Text>
    <Text size="xs" c="dimmed" id="quality-order-help">Drag to reorder, or focus a handle and use the arrow keys.</Text>
    <div role="list" aria-label="Allowed qualities" className="quality-order">
      {qualities.map((quality, rank) => <div role="listitem" key={quality} data-quality={quality} className="quality-order-row"
        data-dragging={drag?.quality === quality || undefined}
        data-drop={drag && drag.quality !== quality && drag.target === quality ? qualities.indexOf(drag.quality) < rank ? "after" : "before" : undefined}>
        <button type="button" className="quality-order-handle" aria-label={`Reorder ${quality}`} aria-describedby="quality-order-help" disabled={busy}
          onPointerDown={e => {
            if (e.button !== 0 || !e.isPrimary) return;
            e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ quality, target: quality });
          }}
          onPointerMove={e => {
            if (!drag) return;
            const target = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-quality]")?.dataset.quality;
            if (target && qualities.includes(target)) setDrag({ quality: drag.quality, target });
          }}
          onPointerUp={() => { if (drag) move(drag.quality, drag.target); setDrag(null); }}
          onPointerCancel={() => setDrag(null)} onLostPointerCapture={() => setDrag(null)}
          onKeyDown={e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDrag(null); return; }
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            const target = qualities[rank + (e.key === "ArrowUp" ? -1 : 1)];
            if (target) move(quality, target);
          }}>
          <IconLine3Horizontal aria-hidden="true" fill="currentColor" /><span className="quality-order-rank">{rank + 1}</span>
          <span className="tantalar-metadata-tag">{metadataLabel("quality", quality)}</span>
        </button>
        <Button size="compact-xs" variant="subtle" aria-label={`Disallow ${quality}`} disabled={busy || !!drag || quality === cutoff || qualities.length === 1} onClick={() => change(qualities.filter(q => q !== quality))}>Disallow</Button>
      </div>)}
    </div>
    <span role="status" className="quality-order-announcement">{announcement}</span>
    <Group gap="xs">{["2160p", "1080p", "720p", "480p"].filter(q => !qualities.includes(q)).map(q => <Button key={q} size="compact-xs" variant="default" disabled={busy} onClick={() => change([...qualities, q])}>Allow {q}</Button>)}</Group>
  </Stack>;
}

export function QualityPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["quality"], queryFn: api.quality });
  const [draft, setDraft] = useState<QualityConfiguration | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ index: number; profile: QualityConfiguration["profiles"][number] } | null>(null);
  const [note, setNote, severity, revision] = useActionFeedback();
  const value = draft ?? query.data;
  if (query.isPending) return <Text>Loading quality management…</Text>;
  if (!value) return <Alert color="red" title="Quality management unavailable"><Button onClick={() => void query.refetch()}>Retry</Button></Alert>;
  const editProfile = (update: Partial<QualityConfiguration["profiles"][number]>) => setEditing(current => current && ({ ...current, profile: { ...current.profile, ...update } }));
  const save = async (configuration = value) => {
    setBusy(true);
    try { await api.saveQuality(configuration); await client.invalidateQueries({ queryKey: ["quality"] }); setDraft(null); setEditing(null); setNote("Quality management saved."); }
    catch (error) { setNote((error as Error).message, "error"); }
    finally { setBusy(false); }
  };
  return <Stack maw={960}>
    <ActionNotice message={note} title="Quality management" severity={severity} revision={revision} />
    <Tabs defaultValue="profiles" keepMounted={false}>
      <Tabs.List aria-label="Quality management views"><Tabs.Tab value="profiles">Profiles</Tabs.Tab><Tabs.Tab value="sizes">Quality definitions</Tabs.Tab><Tabs.Tab value="recycling">Recycle bin</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="profiles" pt="md"><Stack gap="xs">
        <Table.ScrollContainer minWidth={660}><Table verticalSpacing="sm" horizontalSpacing="sm" aria-label="Quality profiles">
          <Table.Thead><Table.Tr><Table.Th>Profile</Table.Th><Table.Th>Qualities · best first</Table.Th><Table.Th>Upgrade until</Table.Th><Table.Th>Proper / repack</Table.Th><Table.Th aria-label="Actions" /></Table.Tr></Table.Thead>
          <Table.Tbody>{value.profiles.map((profile, index) => <Table.Tr key={profile.name}>
            <Table.Th scope="row" fw={600} style={{ whiteSpace: "nowrap" }}>{metadataLabel("quality", profile.name)}</Table.Th>
            <Table.Td><Group gap="xs" wrap="nowrap">{profile.preferredQualities.map(quality => <span key={quality} className="tantalar-metadata-tag">{metadataLabel("quality", quality)}</span>)}</Group></Table.Td>
            <Table.Td>{profile.upgradeAllowed ? <span className="tantalar-metadata-tag">{metadataLabel("quality", profile.cutoff)}</span> : "Disabled"}</Table.Td>
            <Table.Td>{profile.preferProperRepack ? "Preferred" : "No preference"}</Table.Td>
            <Table.Td><Button size="compact-xs" variant="default" aria-label={`Edit ${metadataLabel("quality", profile.name)} profile`} onClick={() => setEditing({ index, profile: { ...profile, preferredQualities: [...profile.preferredQualities] } })}>Edit</Button></Table.Td>
          </Table.Tr>)}</Table.Tbody>
        </Table></Table.ScrollContainer>
        <Text size="xs" c="dimmed">Size alone does not trigger replacement. Resolution downgrades are blocked.</Text>
      </Stack></Tabs.Panel>
      <Tabs.Panel value="sizes" pt="md"><Stack>
        <Text size="sm" c="dimmed">GB presets scale with runtime. Drag or use arrow keys to snap between sizes.</Text>
        {(["movie", "series"] as const).map(kind => <section key={kind}>
          <Group justify="space-between" align="baseline" mb="xs"><Title order={2}>{kind === "movie" ? "Movies" : "Episodes"}</Title><Text size="sm" c="dimmed">{kind === "movie" ? "2-hour reference runtime" : "45-minute reference runtime"}</Text></Group>
          <div className="quality-size-definitions">
            {Object.entries(value.sizes[kind]).map(([quality, rule]) => <div className="quality-size-row" key={quality}>
              <span className="tantalar-metadata-tag">{metadataLabel("quality", quality)}</span>
              {(["min", "preferred", "max"] as const).map(field => <SizeSlider key={field} name={`${kind} ${quality} ${field}`} field={field} value={rule[field]} runtime={kind === "movie" ? 120 : 45}
                lower={field === "min" ? 0 : field === "preferred" ? rule.min : rule.preferred ?? rule.min}
                upper={field === "max" ? null : field === "preferred" ? rule.max : rule.preferred ?? rule.max}
                change={n => setDraft({ ...value, sizes: { ...value.sizes, [kind]: { ...value.sizes[kind], [quality]: { ...rule, [field]: n } } } })} />)}
            </div>)}
          </div>
        </section>)}
        <Text size="sm" c="dimmed">Unknown movie runtime uses 110 minutes. Episodes without runtime cannot pass size checks. Qualities currently distinguish resolution, not release source.</Text>
      </Stack></Tabs.Panel>
      <Tabs.Panel value="recycling" pt="md"><Stack maw={540}>
        <NumberInput label="Recycle-bin retention (days)" min={0} max={3650} allowDecimal={false} value={value.recycleBinDays} onChange={days => setDraft({ ...value, recycleBinDays: Number(days) })} />
        <Text size="sm">Replaced files stay in their library’s recycle bin. Zero disables automatic removal. Cleanup permanently removes expired files.</Text>
        <Button component="a" href="#/admin/jobs" variant="default" w="fit-content">Open cleanup jobs</Button>
      </Stack></Tabs.Panel>
    </Tabs>
    {draft && <Group><Button loading={busy} onClick={() => void save()}>Save changes</Button><Button variant="default" disabled={busy} onClick={() => setDraft(null)}>Discard changes</Button></Group>}
    <Modal opened={!!editing} onClose={() => !busy && setEditing(null)} title={editing ? `Edit ${metadataLabel("quality", editing.profile.name)} profile` : "Edit profile"} closeButtonProps={{ "aria-label": "Close", disabled: busy }} size="sm" centered>
      {editing && <Stack gap="md">
        <ActionNotice message={note} title="Quality management" severity={severity} revision={revision} />
        <Group justify="space-between" align="center">
          <Checkbox label="Allow upgrades" checked={editing.profile.upgradeAllowed} disabled={busy} onChange={e => editProfile({ upgradeAllowed: e.currentTarget.checked })} />
          <Select label="Upgrade until" size="xs" w={130} value={editing.profile.cutoff} disabled={busy || !editing.profile.upgradeAllowed} data={editing.profile.preferredQualities.map(q => ({ value: q, label: metadataLabel("quality", q) }))} onChange={cutoff => cutoff && editProfile({ cutoff })} />
        </Group>
        <Checkbox label="Prefer proper / repack releases" checked={editing.profile.preferProperRepack} disabled={busy} onChange={e => editProfile({ preferProperRepack: e.currentTarget.checked })} />
        <QualityOrder qualities={editing.profile.preferredQualities} cutoff={editing.profile.cutoff} busy={busy} change={preferredQualities => editProfile({ preferredQualities })} />
        <Group justify="flex-end"><Button variant="default" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button loading={busy} onClick={() => void save({ ...value, profiles: value.profiles.map((p, i) => i === editing.index ? editing.profile : p) })}>Save changes</Button></Group>
      </Stack>}
    </Modal>
  </Stack>;
}

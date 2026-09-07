import { DenseGrid } from "../admin/DenseGrid";
import { ActionNotice, useActionFeedback } from "./ActionNotice";
import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Drawer,
  Group,
  NativeSelect,
  Paper,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { api, type LibraryRecord } from "../api";

interface ValidationResult {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<{ code: string; detail: string }>;
}

export function LibraryManager({
  defaultFormOpen = false,
  onConfigured,
}: {
  defaultFormOpen?: boolean;
  onConfigured?: (libraries: ReadonlyArray<LibraryRecord>) => void | Promise<void>;
}) {
  const [libraries, setLibraries] = useState<ReadonlyArray<LibraryRecord>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [kind, setKind] = useState<LibraryRecord["kind"]>("movie");
  const [formOpen, setFormOpen] = useState(defaultFormOpen);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice, noticeSeverity, noticeRevision] = useActionFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [validation, setValidation] = useState<Record<string, ValidationResult>>({});
  const [editing, setEditing] = useState<LibraryRecord | null>(null);
  const [editName, setEditName] = useState("");
  const [editRootPath, setEditRootPath] = useState("");
  const [editKind, setEditKind] = useState<LibraryRecord["kind"]>("movie");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editError, setEditError] = useState<string | null>(null);
  const hasVerifiedLibrary = libraries.some((library) => validation[library.id]?.ok === true);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.libraries();
      setLibraries(result.libraries);
    } catch (error) {
      setLoadError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const validate = async (library: LibraryRecord) => {
    setBusy(`validate:${library.id}`);
    setNotice(null);
    try {
      const result = await api.validateLibrary(library.id);
      const row = result.results.find((candidate) => candidate.library.id === library.id);
      if (!row) throw new Error("The server did not return a validation result for this library.");
      setValidation((current) => ({ ...current, [library.id]: row }));
      setNotice(row.ok ? `${library.name} is ready.` : `${library.name} needs attention.`, row.ok ? "success" : "warning");
    } catch (error) {
      setNotice(`Could not validate ${library.name}: ${(error as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const cleanName = name.trim();
    const cleanPath = rootPath.trim();
    setFormError(null);
    setNotice(null);
    if (!cleanName || !cleanPath) {
      setFormError("Enter a name and an absolute path on the Tantalar server.");
      return;
    }
    setBusy("create");
    try {
      const result = await api.createLibrary({ name: cleanName, rootPath: cleanPath, kind });
      setLibraries((current) => [...current.filter((library) => library.id !== result.library.id), result.library]);
      setName("");
      setRootPath("");
      setFormOpen(false);
      setNotice(`${result.library.name} was created. Tantalar verified its root path.`);
      try {
        const check = await api.validateLibrary(result.library.id);
        const row = check.results.find((candidate) => candidate.library.id === result.library.id);
        if (row) setValidation((current) => ({ ...current, [result.library.id]: row }));
      } catch {
        setNotice(`${result.library.name} was created, but the follow-up validation could not run.`, "warning");
      }
    } catch (error) {
      setFormError((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rescan = async (library: LibraryRecord) => {
    setBusy(`rescan:${library.id}`);
    setNotice(null);
    try {
      const result = await api.rescanLibrary(library.id);
      const warnings = [
        result.skipped > 0 ? `${result.skipped} skipped` : null,
        result.errors.length > 0 ? `${result.errors.length} ${result.errors.length === 1 ? "error" : "errors"}` : null,
      ].filter(Boolean).join("; ");
      setNotice(
        `${library.name}: ${result.discovered} new ${result.discovered === 1 ? "file" : "files"} found; ` +
          `${result.existing} already catalogued; ${result.missingRemoved} missing ` +
          `${result.missingRemoved === 1 ? "entry" : "entries"} removed` +
          (warnings ? `; ${warnings}.` : "."),
        warnings ? "warning" : "success",
      );
    } catch (error) {
      setNotice(`Could not rescan ${library.name}: ${(error as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const openEditor = (library: LibraryRecord) => {
    setFormOpen(false);
    setEditing(library);
    setEditName(library.name);
    setEditRootPath(library.rootPath);
    setEditKind(library.kind);
    setEditEnabled(library.enabled);
    setEditError(null);
  };

  const saveEdit = async () => {
    if (!editing) return;
    const cleanName = editName.trim();
    const cleanPath = editRootPath.trim();
    setEditError(null);
    if (!cleanName || !cleanPath) {
      setEditError("Enter a name and an absolute path on the Tantalar server.");
      return;
    }

    const rootChanged = cleanPath !== editing.rootPath;
    const changes = {
      ...(cleanName !== editing.name ? { name: cleanName } : {}),
      ...(rootChanged ? { rootPath: cleanPath } : {}),
      ...(editKind !== editing.kind ? { kind: editKind } : {}),
    };
    setBusy(`edit:${editing.id}`);
    try {
      let updated = editing;
      if (Object.keys(changes).length > 0) {
        updated = (await api.updateLibrary(editing.id, changes)).library;
      }
      if (editEnabled !== updated.enabled) {
        updated = (await api.setLibraryEnabled(editing.id, editEnabled)).library;
      }
      setLibraries((current) => current.map((library) => library.id === updated.id ? updated : library));
      if (rootChanged) {
        setValidation((current) => {
          const next = { ...current };
          delete next[updated.id];
          return next;
        });
      }
      setEditing(null);
      setNotice(
        rootChanged
          ? `${updated.name} was updated. Scan the library to reconcile its catalog with the new root.`
          : `${updated.name} was updated.`,
      );
    } catch (error) {
      setEditError(`Could not save changes: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (library: LibraryRecord) => {
    setBusy(`remove:${library.id}`);
    setNotice(null);
    try {
      await api.removeLibrary(library.id);
      setLibraries((current) => current.filter((candidate) => candidate.id !== library.id));
      setValidation((current) => {
        const next = { ...current };
        delete next[library.id];
        return next;
      });
      setConfirmRemove(null);
      setNotice(`${library.name} was removed. Media files were not deleted.`);
    } catch (error) {
      setNotice(`Could not remove ${library.name}: ${(error as Error).message}`, "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap="lg" className="tantalar-task-width" data-testid="library-manager">
      <Group justify="space-between" align="center">
        <Group gap="xs">
          {!loading && !loadError ? <Text component="span" size="sm" c="dimmed">{libraries.length} {libraries.length === 1 ? "library" : "libraries"}</Text> : null}
        </Group>
        <Button
          variant={formOpen ? "subtle" : "filled"}
          aria-expanded={formOpen}
          aria-controls="library-create-form"
          onClick={() => {
            setFormError(null);
            setFormOpen((current) => !current);
          }}
        >
          {formOpen ? "Cancel" : "Add library"}
        </Button>
      </Group>

      <Drawer
        opened={editing !== null}
        onClose={() => {
          if (busy?.startsWith("edit:")) return;
          setEditing(null);
          setEditError(null);
        }}
        position="right"
        size="md"
        title="Edit library"
      >
        {editing ? (
          <form
            aria-label={`Edit ${editing.name}`}
            onSubmit={(event) => {
              event.preventDefault();
              void saveEdit();
            }}
          >
            <Stack gap="md">
              <Text size="sm" c="dimmed">
                This changes the library definition only. Tantalar never moves or deletes media files here.
              </Text>
              <TextInput
                label="Library name"
                maxLength={120}
                required
                value={editName}
                onChange={(event) => setEditName(event.currentTarget.value)}
              />
              <NativeSelect
                label="Media type"
                value={editKind}
                onChange={(event) => setEditKind(event.currentTarget.value as LibraryRecord["kind"])}
                data={[
                  { value: "movie", label: "Movies" },
                  { value: "series", label: "Series" },
                  { value: "mixed", label: "Mixed media" },
                ]}
              />
              <TextInput
                label="Root path"
                description="Tantalar validates this server path before storing the change."
                required
                value={editRootPath}
                onChange={(event) => setEditRootPath(event.currentTarget.value)}
              />
              {editRootPath.trim() !== editing.rootPath ? (
                <Alert color="yellow" title="Scan required after saving">
                  The new root must already exist. After saving, scan this library to reconcile its catalog safely.
                </Alert>
              ) : null}
              <Switch
                label="Library enabled"
                description="Disabled libraries stay configured but are unavailable to viewers."
                checked={editEnabled}
                onChange={(event) => setEditEnabled(event.currentTarget.checked)}
              />
              {editError ? <Alert color="red" role="alert">{editError}</Alert> : null}
              <Group justify="flex-end">
                <Button variant="default" disabled={busy !== null} onClick={() => setEditing(null)}>Cancel</Button>
                <Button type="submit" loading={busy === `edit:${editing.id}`} disabled={busy !== null && busy !== `edit:${editing.id}`}>
                  Save changes
                </Button>
              </Group>
            </Stack>
          </form>
        ) : null}
      </Drawer>

      {formOpen ? (
        <form
          id="library-create-form"
          aria-label="Add a media library"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Paper p="md" radius="md" withBorder>
            <Stack gap="sm">
              <div>
                <Title order={4}>Add a library</Title>
                <Text size="sm" c="dimmed">
                  Use an existing directory on the machine running Tantalar. The server checks the path before saving it.
                </Text>
              </div>
              <TextInput
                label="Library name"
                name="library-name"
                placeholder="Movies"
                maxLength={120}
                required
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              <NativeSelect
                label="Media type"
                name="library-kind"
                value={kind}
                onChange={(event) => setKind(event.currentTarget.value as LibraryRecord["kind"])}
                data={[
                  { value: "movie", label: "Movies" },
                  { value: "series", label: "Series" },
                  { value: "mixed", label: "Mixed media" },
                ]}
              />
              <TextInput
                label="Root path"
                name="library-root-path"
                description="This is a server path, not a folder on the device running your browser."
                placeholder="/media/movies"
                required
                value={rootPath}
                onChange={(event) => setRootPath(event.currentTarget.value)}
              />
              {formError ? <Alert color="red" role="alert">{formError}</Alert> : null}
              <Group justify="flex-end">
                <Button type="submit" loading={busy === "create"} disabled={busy !== null && busy !== "create"}>Save library</Button>
              </Group>
            </Stack>
          </Paper>
        </form>
      ) : null}

      <Stack gap="sm">
        {loading ? <Text aria-busy="true">Loading libraries…</Text> : null}
        {loadError ? (
          <Alert color="red" role="alert" title="Library connection failed">
            <Stack gap="xs">
              <Text size="sm">Tantalar could not load library settings. Check that the server is running, then retry.</Text>
              <Text size="xs" c="dimmed">{loadError}</Text>
              <Group><Button size="xs" variant="light" onClick={() => void load()}>Retry connection</Button></Group>
            </Stack>
          </Alert>
        ) : null}
        {!loading && !loadError && libraries.length === 0 ? (
          <Paper p="md" radius="md" withBorder>
            <Text size="sm" c="dimmed">No libraries yet. Add one to make media available in Tantalar.</Text>
          </Paper>
        ) : null}
        <DenseGrid testId="libraries-grid" ariaLabel="libraries" data={libraries} defaultView="list" loading={loading} rowTestId={library => `library-${library.id}`}
          filters={[{ id: "kind", label: "Types", options: ["movie", "series", "mixed"].map(value => ({ value, label: value })) }]}
          columns={[
            { id: "name", header: "Name", accessorKey: "name", size: 200 },
            { id: "kind", header: "Type", accessorKey: "kind", size: 90 },
            { id: "rootPath", header: "Path", accessorKey: "rootPath", size: 320 },
            { id: "enabled", header: "State", accessorFn: library => library.enabled ? "Enabled" : "Disabled", size: 100 },
            { id: "actions", header: "Actions", enableHiding: false, size: 460, cell: ({ row }) => { const library = row.original; const check = validation[library.id]; return <Stack gap="sm">                  <Group gap="xs">
                    <Button
                      variant="default"
                      size="compact-sm"
                      disabled={busy !== null}
                      onClick={() => openEditor(library)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="light"
                      size="compact-sm"
                      loading={busy === `validate:${library.id}`}
                      disabled={busy !== null}
                      onClick={() => void validate(library)}
                    >
                      Test path
                    </Button>
                    <Button
                      variant="default"
                      size="compact-sm"
                      loading={busy === `rescan:${library.id}`}
                      disabled={busy !== null}
                      onClick={() => void rescan(library)}
                    >
                      Scan library
                    </Button>
                    <Button color="red" variant="subtle" size="compact-sm" disabled={busy !== null} onClick={() => setConfirmRemove(library.id)}>
                      Remove
                    </Button>
                  </Group>                {check ? (
                  <Alert color={check.ok ? "green" : "yellow"} title={check.ok ? "Path is ready" : "Path needs attention"}>
                    {check.ok
                      ? "Tantalar can use this library root."
                      : check.issues.map((issue) => issue.detail || issue.code).join(" ")}
                  </Alert>
                ) : null}
                {confirmRemove === library.id ? (
                  <Alert color="red" title={`Remove ${library.name}?`} role="alertdialog">
                    <Stack gap="sm">
                      <Text size="sm">This removes the library definition and catalog records. It does not delete media files.</Text>
                      <Group justify="flex-end">
                        <Button variant="default" disabled={busy !== null} onClick={() => setConfirmRemove(null)}>Cancel</Button>
                        <Button
                          color="red"
                          loading={busy === `remove:${library.id}`}
                          disabled={busy !== null}
                          onClick={() => void remove(library)}
                        >
                          Remove definition
                        </Button>
                      </Group>
                    </Stack>
                  </Alert>
                ) : null}</Stack>; } },
          ]}
        />
      </Stack>

      <ActionNotice message={notice} title="Libraries" severity={noticeSeverity} revision={noticeRevision} />
      {onConfigured && libraries.length > 0 ? (
        <Stack gap="xs">
          {!hasVerifiedLibrary ? (
            <Text size="sm" c="dimmed">
              Test at least one saved library path successfully to continue setup.
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button
              loading={busy === "continue"}
              disabled={busy !== null || !hasVerifiedLibrary}
              onClick={() => {
                if (!hasVerifiedLibrary) return;
                setBusy("continue");
                Promise.resolve(onConfigured(libraries)).finally(() => setBusy(null));
              }}
            >
              Continue with {libraries.length === 1 ? "this library" : "these libraries"}
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Stack>
  );
}

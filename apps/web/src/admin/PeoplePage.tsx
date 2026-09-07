import { useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Checkbox, Drawer, Group, NativeSelect, PasswordInput, Stack, Tabs, Text, TextInput } from "@mantine/core";
import { api, type UserAccount } from "../api";
import { CollectionUserContext, DenseGrid, initialExplorerQuery } from "./DenseGrid";
import { PictureEditor, ProfilePicture } from "../components/ProfilePicture";
import { ActionNotice, useActionFeedback } from "../components/ActionNotice";
import { formatShortDate } from "../date";
import "./people.css";

export function UsersView() {
  const qc = useQueryClient();
  const actorId = useContext(CollectionUserContext);
  const [query, setQuery] = useState(initialExplorerQuery);
  const users = useQuery({ queryKey: ["admin", "users", query], queryFn: () => api.users(query), retry: false });
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote, severity, revision] = useActionFeedback();
  const create = async () => {
    setBusy(true); setError(null);
    try {
      const result = await api.createUser(username.trim(), password, role);
      setCreating(false); setUsername(""); setPassword("");
      setNote(`${result.user.username} can now sign in.`);
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
      try { setEditing((await api.userProfile(result.user.id)).user); }
      catch { setNote("Account created. Open its profile to finish setup.", "warning"); }
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <Stack gap="md" className="tantalar-people">
    <ActionNotice message={note} title="People" severity={severity} revision={revision} />
    <Group justify="space-between"><Text c="dimmed">{users.data ? `${users.data.total ?? users.data.users.length} accounts` : "Accounts"}</Text><Button onClick={() => { setCreating(true); setError(null); setRole("viewer"); }}>Add person</Button></Group>
    {users.isError ? <Stack role="alert"><Text>{users.error.message}</Text><Button variant="default" onClick={() => void users.refetch()}>Retry</Button></Stack> : null}
    <DenseGrid<UserAccount> testId="users-grid" ariaLabel="people" data={users.data?.users ?? []} total={users.data?.total ?? users.data?.users.length ?? 0} onQueryChange={setQuery} loading={users.isFetching}
      defaultView="medium" rowTestId={user => `user-${user.username}`} emptyMessage="No matching people. Adjust your search or add a person."
      artwork={user => <button className="tantalar-people__picture" type="button" aria-label={`Manage ${user.username}'s profile`} onClick={() => setEditing(user)}><ProfilePicture avatar={user.avatar} name={user.username} decorative /></button>}
      filters={[{ id: "role", label: "Role", options: [{ value: "admin", label: "Administrator" }, { value: "viewer", label: "Viewer" }] }, { id: "state", label: "Status", options: [{ value: "Active", label: "Active" }, { value: "Inactive", label: "Inactive" }] }]}
      columns={[
        { id: "username", header: "Name", accessorKey: "username", size: 220, cell: ({ row }) => <button className="tantalar-people__name" type="button" onClick={() => setEditing(row.original)}>{row.original.username}</button> },
        { id: "role", header: "Role", accessorKey: "role", size: 140, cell: ({ row }) => row.original.role === "admin" ? "Administrator" : "Viewer", meta: { compact: true } },
        { id: "state", header: "Status", accessorFn: user => user.active === false ? "Inactive" : "Active", size: 100, meta: { compact: true } },
        { id: "createdAt", header: "Joined", accessorKey: "createdAt", size: 140, cell: ({ row }) => formatShortDate(row.original.createdAt) },
        { id: "actions", header: "Actions", size: 130, enableHiding: false, cell: ({ row }) => <Button variant="default" size="compact-sm" onClick={() => setEditing(row.original)}>Manage profile</Button> },
      ]}
    />
    <Drawer opened={creating} onClose={() => { if (!busy) { setCreating(false); setPassword(""); } }} title="Add person" closeButtonProps={{ "aria-label": "Close add person" }} position="right" size="sm">
      <Stack component="form" onSubmit={event => { event.preventDefault(); void create(); }}>
        <TextInput label="Username" autoComplete="off" required maxLength={64} value={username} onChange={event => setUsername(event.currentTarget.value)} />
        <PasswordInput label="Temporary password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.currentTarget.value)} />
        <NativeSelect label="Access level" value={role} onChange={event => setRole(event.currentTarget.value as "admin" | "viewer")} data={[{ value: "viewer", label: "Viewer" }, { value: "admin", label: "Administrator" }]} />
        {error ? <Text role="alert" c="var(--tantalar-color-danger)">{error}</Text> : null}
        <Button type="submit" loading={busy}>Create account</Button>
      </Stack>
    </Drawer>
    <Drawer opened={editing !== null} onClose={() => setEditing(null)} title={editing ? `Manage ${editing.username}` : "Manage person"} closeButtonProps={{ "aria-label": "Close profile" }} position="right" size="md">
      {editing ? <PersonEditor key={editing.id} user={editing} ownAccount={actorId === editing.id} onUpdate={setEditing} /> : null}
    </Drawer>
  </Stack>;
}

function PersonEditor({ user, ownAccount, onUpdate }: { user: UserAccount; ownAccount: boolean; onUpdate: (user: UserAccount) => void }) {
  const qc = useQueryClient();
  const [role, setRole] = useState(user.role);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState<"deactivate" | "revoke" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote, severity, revision] = useActionFeedback();
  const [tab, setTab] = useState<string | null>("profile");
  const libraries = useQuery({ queryKey: ["admin", "libraries"], queryFn: api.libraries, enabled: tab === "access" });
  const access = useQuery({ queryKey: ["admin", "user-libraries", user.id], queryFn: () => api.userLibraries(user.id), enabled: tab === "access" });
  const [selectedLibraries, setSelectedLibraries] = useState<string[] | null>(null);
  const act = async (operation: () => Promise<unknown>, message: string, update?: Partial<UserAccount>) => {
    setBusy(true);
    try { await operation(); if (update) onUpdate({ ...user, ...update }); setNote(message); setConfirmation(null); setPassword(""); await qc.invalidateQueries({ queryKey: ["admin", "users"] }); }
    catch (error) { setNote((error as Error).message, "error"); }
    finally { setBusy(false); }
  };
  return <Stack gap="md">
    <ActionNotice message={note} title={user.username} severity={severity} revision={revision} />
    <Group className="tantalar-people__identity"><div><ProfilePicture avatar={user.avatar} name={user.username} /></div><div><Text fw={600}>{user.username}{ownAccount ? " · You" : ""}</Text><Text size="sm" c="dimmed">{user.role === "admin" ? "Administrator" : "Viewer"} · {user.active === false ? "Inactive" : "Active"}</Text><Text size="xs" c="dimmed">Joined {formatShortDate(user.createdAt)}</Text></div></Group>
    <Tabs value={tab} onChange={setTab}>
      <Tabs.List aria-label="Person settings"><Tabs.Tab value="profile">Picture</Tabs.Tab><Tabs.Tab value="access">Access</Tabs.Tab><Tabs.Tab value="security">Security</Tabs.Tab></Tabs.List>
      <Tabs.Panel value="profile" pt="md"><PictureEditor userId={user.id} username={user.username} avatar={user.avatar} onSaved={avatar => { onUpdate({ ...user, avatar }); void qc.invalidateQueries({ queryKey: ["admin", "users"] }); }} /></Tabs.Panel>
      <Tabs.Panel value="access" pt="md"><Stack>
        <NativeSelect label="Access level" value={role} onChange={event => setRole(event.currentTarget.value)} data={[{ value: "viewer", label: "Viewer" }, { value: "admin", label: "Administrator" }]} />
        {role !== user.role ? <Text size="sm">{role === "admin" ? "Administrators can manage all accounts and server settings." : "Changing to Viewer signs out existing sessions."}</Text> : null}
        <Button variant="default" disabled={role === user.role} loading={busy} onClick={() => void act(() => api.setUserRole(user.id, role as "admin" | "viewer"), "Access level saved.", { role })}>Save access level</Button>
        <Text fw={600}>Library access</Text>
        {user.role === "admin" ? <Text size="sm" c="dimmed">Administrators have access to all enabled libraries.</Text> : access.isPending || libraries.isPending ? <Text role="status">Loading libraries…</Text> : access.isError || libraries.isError ? <Stack role="alert"><Text>Library access could not be loaded.</Text><Button variant="default" onClick={() => { void access.refetch(); void libraries.refetch(); }}>Retry</Button></Stack> : <>
          <Text size="sm" c="dimmed">Only selected libraries are available. No selection means no library access.</Text>
          <Checkbox.Group value={selectedLibraries ?? [...access.data.libraryIds]} onChange={setSelectedLibraries}><Stack gap="xs">{libraries.data.libraries.map(library => <Checkbox key={library.id} value={library.id} label={library.name} />)}</Stack></Checkbox.Group>
          {!libraries.data.libraries.length ? <Text size="sm">No configured libraries.</Text> : null}
          <Button variant="default" disabled={selectedLibraries === null} loading={busy} onClick={() => void act(async () => { await api.setUserLibraries(user.id, selectedLibraries ?? []); await access.refetch(); setSelectedLibraries(null); }, "Library access saved.")}>Save library access</Button>
        </>}
      </Stack></Tabs.Panel>
      <Tabs.Panel value="security" pt="md"><Stack>
        <Stack component="form" onSubmit={event => { event.preventDefault(); void act(() => api.resetUserPassword(user.id, password), "Password reset. Existing sessions were signed out."); }}>
          <PasswordInput label="New password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={event => setPassword(event.currentTarget.value)} />
          <Text size="sm" c="dimmed">Resetting the password signs out existing sessions.</Text><Button variant="default" type="submit" disabled={password.length < 8} loading={busy}>Reset password</Button>
        </Stack>
        <Button variant="default" disabled={busy} onClick={() => setConfirmation("revoke")}>Sign out all sessions</Button>
        {user.active === false ? <Button variant="default" loading={busy} onClick={() => void act(() => api.setUserActive(user.id, true), "Account reactivated.", { active: true })}>Reactivate account</Button> : <Button variant="default" disabled={ownAccount || busy} onClick={() => setConfirmation("deactivate")}>Deactivate account</Button>}
        {ownAccount ? <Text size="xs" c="dimmed">You cannot deactivate your own account.</Text> : null}
        {confirmation ? <Stack role="region" aria-label="Confirm account action" className="tantalar-people__confirmation"><Text>{confirmation === "deactivate" ? "This account will lose access. Watch history and settings will be kept." : "All active sessions for this account will be signed out."}</Text><Group><Button variant="default" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button><Button loading={busy} onClick={() => void (confirmation === "deactivate" ? act(() => api.setUserActive(user.id, false), "Account deactivated.", { active: false }) : act(() => api.revokeUserSessions(user.id), "All sessions signed out."))}>Confirm {confirmation === "deactivate" ? "deactivation" : "sign out"}</Button></Group></Stack> : null}
      </Stack></Tabs.Panel>
    </Tabs>
  </Stack>;
}

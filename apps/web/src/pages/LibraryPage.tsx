/**
 * Library browsing: responsive grid of visible items, collections rows and
 * a continue-watching row with per-item progress. Restricted viewers see
 * only what the serving capability returns (fail-closed server side).
 */
import { useQuery } from "@tanstack/react-query";
import { Card, Grid, Group, Progress, Stack, Title, Text, SimpleGrid } from "@mantine/core";
import { api, type LibraryItem } from "../api";

function ItemCard({ item, onWatch }: { item: LibraryItem; onWatch: (fileId: string) => void }) {
  return (
    <Card
      component="button"
      data-testid={`library-item-${item.fileId}`}
      onClick={() => onWatch(item.fileId)}
      shadow="sm"
      padding="md"
      radius="md"
      style={{ textAlign: "left", cursor: "pointer", width: "100%" }}
    >
      <Title order={5}>{item.title}</Title>
      <Text size="sm" c="dimmed">
        {item.kind === "series" ? "Series" : "Movie"}
      </Text>
    </Card>
  );
}

export function LibraryPage({ onWatch }: { onWatch: (fileId: string) => void }) {
  const q = useQuery({ queryKey: ["library"], queryFn: () => api.browse() });

  if (q.isPending) return <div aria-busy="true">Loading library…</div>;
  if (q.isError) {
    return (
      <div role="alert">
        Could not load the library. <Text size="sm">{(q.error as Error).message}</Text>
      </div>
    );
  }

  const byId = new Map(q.data.items.map((i) => [i.fileId, i]));

  return (
    <Stack gap="lg" data-testid="library-page">
      {q.data.continueWatching.length > 0 ? (
        <section aria-label="Continue watching">
          <Title order={4}>Continue watching</Title>
          <SimpleGrid cols={{ base: 1, sm: 2, md: 4 }} mt="sm">
            {q.data.continueWatching.map((cw) => {
              const item = byId.get(cw.fileId);
              const pct = cw.durationMs > 0 ? Math.min(100, (cw.positionMs / cw.durationMs) * 100) : 0;
              return (
                <Card
                  key={cw.fileId}
                  component="button"
                  data-testid={`continue-${cw.fileId}`}
                  onClick={() => onWatch(cw.fileId)}
                  shadow="sm"
                  padding="md"
                  radius="md"
                  style={{ textAlign: "left", cursor: "pointer", width: "100%" }}
                >
                  <Group justify="space-between">
                    <Title order={6}>{item?.title ?? cw.fileId}</Title>
                    <Text size="xs" c="dimmed">{Math.round(pct)}%</Text>
                  </Group>
                  <Progress value={pct} mt="xs" />
                </Card>
              );
            })}
          </SimpleGrid>
        </section>
      ) : null}

      <section aria-label="Library items">
        <Title order={4}>Library</Title>
        {q.data.items.length === 0 ? (
          <Text c="dimmed" mt="sm">No items are visible to you.</Text>
        ) : (
          <Grid mt="sm">
            {q.data.items.map((item) => (
              <Grid.Col key={item.fileId} span={{ base: 12, sm: 6, md: 4, lg: 3 }}>
                <ItemCard item={item} onWatch={onWatch} />
              </Grid.Col>
            ))}
          </Grid>
        )}
      </section>
    </Stack>
  );
}

import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { get, qs } from "../../api/client.js";
import { STALE } from "../../lib/query.js";
import {
  Button,
  Card,
  ErrorBox,
  Loading,
  Meter,
  PageHeader,
  Pagination,
  StatusBadge,
  Table,
  fmt,
} from "../../components/ui.jsx";

export default function Campaigns() {
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useQuery({
    queryKey: ["campaigns", { archived, page }],
    queryFn: () => get(`/api/campaigns${qs({ archived, page, pageSize: 20 })}`),
    staleTime: STALE.campaigns,
    refetchInterval: (q) =>
      q.state.data?.items?.some((c) => c.status === "SENDING") ? 30_000 : false,
  });
  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle={
          data
            ? `${data.working.count} of ${data.working.limit} working campaigns in use`
            : " "
        }
        actions={
          <Link to="/app/campaigns/new">
            <Button
              variant="brand"
              disabled={data && data.working.count >= data.working.limit}
            >
              Create campaign
            </Button>
          </Link>
        }
      />
      <div className="mb-3 flex gap-2">
        <Button
          size="sm"
          variant={!archived ? "primary" : "secondary"}
          onClick={() => {
            setArchived(false);
            setPage(1);
          }}
        >
          Active
        </Button>
        <Button
          size="sm"
          variant={archived ? "primary" : "secondary"}
          onClick={() => {
            setArchived(true);
            setPage(1);
          }}
        >
          Archived
        </Button>
      </div>
      {error && !data && <ErrorBox error={error} />}
      {isLoading && !data ? (
        <Loading />
      ) : (
        data && (
          <Card padded={false}>
            <Table
              head={[
                "Campaign",
                "Status",
                "Sender",
                "Progress",
                "Sent",
                "Opened*",
                "Replied",
                "Bounced",
                "Created",
              ]}
              empty={
                !data.items.length && (
                  <div className="p-8 text-center text-sm text-muted">
                    No campaigns here.
                  </div>
                )
              }
            >
              {data.items.map((c) => (
                <tr key={c.id} className="hover:bg-subtle">
                  <td className="td">
                    <Link
                      className="font-medium text-brand-700 dark:text-brand-300 hover:underline"
                      to={`/app/campaigns/${c.id}`}
                    >
                      {c.name}
                    </Link>
                    <div className="text-xs text-faint">
                      {c.type === "FOLLOWUP" ? "Follow-up" : "Fresh"} ·{" "}
                      {c.hourlyRate}/h
                    </div>
                  </td>
                  <td className="td">
                    <StatusBadge status={c.status} />
                    {c.status === "SCHEDULED" && (
                      <div className="text-xs text-muted">
                        starts {fmt.date(c.scheduledAt)}
                      </div>
                    )}
                    {c.status === "SENDING" && c.startedAt && (
                      <div className="text-xs text-muted">
                        started {fmt.date(c.startedAt)}
                      </div>
                    )}
                    {["SENDING", "SCHEDULED"].includes(c.status) &&
                      c.eta?.finishAt && (
                        <div
                          className="text-xs text-brand-700 dark:text-brand-300"
                          title={fmt.date(c.eta.finishAt)}
                        >
                          ends ~{fmt.date(c.eta.finishAt)}
                        </div>
                      )}
                    {c.status === "COMPLETED" && c.completedAt && (
                      <div className="text-xs text-muted">
                        done {fmt.date(c.completedAt)}
                      </div>
                    )}
                  </td>
                  <td className="td text-xs">
                    {c.accountIds?.length > 1
                      ? `${c.accountIds.length} accounts`
                      : c.account?.email ||
                        (c.type === "FOLLOWUP" ? "Original senders" : "—")}
                  </td>
                  <td className="td w-36">
                    <Meter
                      kind="progress"
                      label={`${c.stats.completion}%`}
                      value={c.stats.total - c.stats.pending - c.stats.sending}
                      max={c.stats.total}
                    />
                  </td>
                  <td className="td">{c.stats.sent}</td>
                  <td className="td">{c.stats.opened}</td>
                  <td className="td">{c.stats.replied}</td>
                  <td className="td">{c.stats.bounced}</td>
                  <td className="td text-xs">{fmt.date(c.createdAt)}</td>
                </tr>
              ))}
            </Table>
            <Pagination
              page={page}
              pageSize={20}
              total={data.total}
              onPage={setPage}
            />
          </Card>
        )
      )}
      <p className="mt-2 text-xs text-faint">* Opens are approximate.</p>
    </>
  );
}

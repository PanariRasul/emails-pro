import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { get } from "../../api/client.js";
import { STALE } from "../../lib/query.js";
import {
  Button,
  Card,
  ErrorBox,
  Loading,
  PageHeader,
  Table,
  fmt,
} from "../../components/ui.jsx";

const LEAD_LABELS = [
  ["INTERESTED", "Interested", "text-emerald-600 dark:text-emerald-400"],
  ["MEETING", "Meeting", "text-brand-600 dark:text-brand-300"],
  ["NOT_INTERESTED", "Not interested", "text-fg2"],
  ["WRONG_PERSON", "Wrong person", "text-fg2"],
  ["OUT_OF_OFFICE", "Out of office", "text-amber-600 dark:text-amber-400"],
];

function Responses({ days }) {
  const { data } = useQuery({
    queryKey: ["responses", days],
    queryFn: () => get(`/api/reports/responses?days=${days}`),
    staleTime: 60_000,
  });
  if (!data) return null;
  const pitches = [...data.pitches].sort(
    (a, b) => b.replyRate - a.replyRate || b.sent - a.sent,
  );
  const subjects = [...data.subjects].sort(
    (a, b) => b.replyRate - a.replyRate || b.sent - a.sent,
  );
  const best = subjects.find((x) => x.sent >= 10);
  return (
    <>
      <Card title={`Responses · last ${days} days`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {LEAD_LABELS.map(([k, l, c]) => (
            <div key={k} className="rounded-2xl bg-subtle p-3">
              <div className="text-xs text-muted">{l}</div>
              <div className={`mt-1 text-2xl font-semibold tabular-nums ${c}`}>
                {data.leads[k] || 0}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted">
          Mark each reply in the Inbox (Interested, Meeting, …) to see which
          pitches bring real results. {data.note}
        </p>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Pitch performance" padded={false}>
          <Table
            head={[
              "Pitch",
              "Type",
              "Sent",
              "Replies",
              "Reply rate",
              "Interested",
            ]}
            empty={
              !pitches.length && (
                <div className="p-6 text-center text-sm text-muted">
                  Send a campaign that uses a pitch to see results here.
                </div>
              )
            }
          >
            {pitches.map((p) => (
              <tr key={`${p.id}-${p.type}`}>
                <td className="td font-medium">{p.name}</td>
                <td className="td text-xs">
                  {p.type === "FOLLOWUP" ? "Follow-up" : "First email"}
                </td>
                <td className="td">{p.sent}</td>
                <td className="td">{p.replied}</td>
                <td className="td font-semibold">{p.replyRate}%</td>
                <td className="td">{p.interested}</td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Subject lines" padded={false}>
          {best && (
            <p className="px-5 pt-4 text-sm">
              Best so far: <b>{best.subject}</b> — {best.replyRate}% replies
              from {best.sent} emails.
            </p>
          )}
          <Table
            head={["Subject line", "Sent", "Opened", "Reply rate"]}
            empty={
              !subjects.length && (
                <div className="p-6 text-center text-sm text-muted">
                  No emails sent yet.
                </div>
              )
            }
          >
            {subjects.map((x) => (
              <tr key={x.subject}>
                <td className="td max-w-xs truncate">{x.subject}</td>
                <td className="td">{x.sent}</td>
                <td className="td">{x.openRate}%</td>
                <td className="td font-semibold">{x.replyRate}%</td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}

export default function Analytics() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", days],
    queryFn: () => get(`/api/reports/analytics?days=${days}`),
    staleTime: STALE.stats,
  });
  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle={data?.note}
        actions={[7, 30, 90].map((d) => (
          <Button
            key={d}
            size="sm"
            variant={days === d ? "primary" : "secondary"}
            onClick={() => setDays(d)}
          >
            {d} days
          </Button>
        ))}
      />
      {data?.tracking && !data.tracking.reachable && (
        <div className="mb-4 rounded-2xl border bg-brand-500/10 px-4 py-3 text-sm text-brand-800 dark:text-brand-200">
          <b>Opens and clicks can't be counted yet:</b> tracking links point to{" "}
          {data.tracking.url}, which recipients can't reach. They work once the
          app is deployed on its public address.
        </div>
      )}
      {error && !data && <ErrorBox error={error} />}
      {isLoading && !data ? (
        <Loading />
      ) : (
        data && (
          <div className="space-y-4">
            <Responses days={Math.max(days, 30)} />
            <Card title="Daily activity">
              <div className="h-72">
                <ResponsiveContainer>
                  <LineChart data={data.daily}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#94a3b833" />
                    <XAxis dataKey="day" fontSize={11} />
                    <YAxis fontSize={11} allowDecimals={false} />
                    <Tooltip />
                    <Legend />
                    <Line dataKey="sent" stroke="#64748b" dot={false} />
                    <Line dataKey="opened" stroke="#0ea5e9" dot={false} />
                    <Line dataKey="replied" stroke="#10b981" dot={false} />
                    <Line dataKey="bounced" stroke="#ef4444" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card title="By sending account" padded={false}>
              <div className="h-60 p-4">
                <ResponsiveContainer>
                  <BarChart data={data.byAccount}>
                    <XAxis dataKey="email" fontSize={10} />
                    <YAxis fontSize={11} />
                    <Tooltip />
                    <Bar dataKey="sent" fill="#64748b" />
                    <Bar dataKey="replied" fill="#10b981" />
                    <Bar dataKey="bounced" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table
                head={[
                  "Account",
                  "Sent",
                  "Replied",
                  "Reply rate",
                  "Bounced",
                  "Bounce rate",
                ]}
              >
                {data.byAccount.map((a) => (
                  <tr key={a.email}>
                    <td className="td">{a.email}</td>
                    <td className="td">{a.sent}</td>
                    <td className="td">{a.replied}</td>
                    <td className="td">{fmt.pct(a.replied, a.sent)}</td>
                    <td className="td">{a.bounced}</td>
                    <td className="td">{fmt.pct(a.bounced, a.sent)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        )
      )}
    </>
  );
}

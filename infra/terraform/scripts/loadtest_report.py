#!/usr/bin/env python3
"""Avalia uma execução do teste de carga (docs/teste-de-carga-aws-1000tps.md, seções 6, 7 e 10).

Lê o resumo JSON do k6, coleta as métricas da janela no CloudWatch (AWS CLI) e confere os critérios C1 a C11.
Grava um relatório Markdown (`--out`) e imprime a tabela de critérios. Sai com 0 se aprovado, 1 se reprovado.
"""
import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone


def aws(*args):
    out = subprocess.run(["aws", *args, "--output", "json"], check=True, capture_output=True, text=True).stdout
    return json.loads(out) if out.strip() else {}


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def metric_query(qid, namespace, name, dims, stat):
    return {
        "Id": qid,
        "MetricStat": {
            "Metric": {"Namespace": namespace, "MetricName": name, "Dimensions": [{"Name": k, "Value": v} for k, v in dims.items()]},
            "Period": 60,
            "Stat": stat,
        },
        "ReturnData": True,
    }


def fetch(queries, start, end):
    """Retorna {id: [(timestamp, valor), ...]} ordenado por tempo."""
    with tempfile.NamedTemporaryFile("w", suffix=".json") as f:
        json.dump(queries, f)
        f.flush()
        res = aws("cloudwatch", "get-metric-data", "--metric-data-queries", f"file://{f.name}",
                  "--start-time", iso(start), "--end-time", iso(end))
    series = {}
    for r in res.get("MetricDataResults", []):
        pts = sorted(zip([datetime.fromisoformat(t.replace("Z", "+00:00")) for t in r["Timestamps"]], r["Values"]))
        series[r["Id"]] = pts
    return series


def window(points, lo, hi):
    return [v for t, v in points if lo <= t <= hi]


def stat(vals, fn, default=None):
    return fn(vals) if vals else default


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--summary", required=True, help="JSON do handleSummary do k6")
    p.add_argument("--start", required=True, help="início da execução do k6 (ISO UTC)")
    p.add_argument("--end", required=True, help="fim da execução do k6, com drain (ISO UTC)")
    p.add_argument("--rate", type=float, required=True)
    p.add_argument("--duration", type=float, required=True)
    p.add_argument("--warmup", type=float, default=0)
    p.add_argument("--cluster", default="fraud-detector")
    p.add_argument("--service", default="fraud-detector")
    p.add_argument("--db", default="fraud-detector")
    p.add_argument("--topic", default="alerts.fifo")
    p.add_argument("--queue", default="transactions")
    p.add_argument("--dlq", action="append", default=[])
    p.add_argument("--desired", type=int, default=3)
    p.add_argument("--meta", default="", help="linha livre para o cabeçalho (perfil, commit, imagem)")
    p.add_argument("--out", required=True)
    a = p.parse_args()

    summary = json.load(open(a.summary))
    m = summary["metrics"]

    def val(name, key, default=None):
        return (m.get(name) or {}).get("values", {}).get(key, default)

    start = datetime.fromisoformat(a.start.replace("Z", "+00:00"))
    end = datetime.fromisoformat(a.end.replace("Z", "+00:00"))
    steady_lo = start + timedelta(seconds=a.warmup)
    steady_hi = steady_lo + timedelta(seconds=a.duration)

    # --- CloudWatch ------------------------------------------------------------------------------
    sqs_dim = {"QueueName": a.queue}
    ecs_dim = {"ClusterName": a.cluster, "ServiceName": a.service}
    rds_dim = {"DBInstanceIdentifier": a.db}
    sns_dim = {"TopicName": a.topic}
    queries = [
        metric_query("age", "AWS/SQS", "ApproximateAgeOfOldestMessage", sqs_dim, "Maximum"),
        metric_query("visible", "AWS/SQS", "ApproximateNumberOfMessagesVisible", sqs_dim, "Maximum"),
        metric_query("sent", "AWS/SQS", "NumberOfMessagesSent", sqs_dim, "Sum"),
        metric_query("deleted", "AWS/SQS", "NumberOfMessagesDeleted", sqs_dim, "Sum"),
        metric_query("ecs_cpu", "AWS/ECS", "CPUUtilization", ecs_dim, "Average"),
        metric_query("ecs_cpu_max", "AWS/ECS", "CPUUtilization", ecs_dim, "Maximum"),
        metric_query("ecs_mem", "AWS/ECS", "MemoryUtilization", ecs_dim, "Average"),
        metric_query("rds_cpu", "AWS/RDS", "CPUUtilization", rds_dim, "Average"),
        metric_query("rds_cpu_max", "AWS/RDS", "CPUUtilization", rds_dim, "Maximum"),
        metric_query("rds_conn", "AWS/RDS", "DatabaseConnections", rds_dim, "Maximum"),
        metric_query("rds_wlat", "AWS/RDS", "WriteLatency", rds_dim, "Maximum"),
        metric_query("sns_pub", "AWS/SNS", "NumberOfMessagesPublished", sns_dim, "Sum"),
        metric_query("sns_fail", "AWS/SNS", "NumberOfNotificationsFailed", sns_dim, "Sum"),
    ]
    for i, dlq in enumerate(a.dlq):
        queries.append(metric_query(f"dlq{i}", "AWS/SQS", "ApproximateNumberOfMessagesVisible", {"QueueName": dlq}, "Maximum"))
    cw = fetch(queries, start - timedelta(minutes=1), end + timedelta(minutes=3))

    def steady(qid):
        return window(cw.get(qid, []), steady_lo, steady_hi)

    # tasks paradas durante a execução (Spot reclamado, falha de healthcheck, OOM...)
    stopped = []
    try:
        arns = aws("ecs", "list-tasks", "--cluster", a.cluster, "--service-name", a.service, "--desired-status", "STOPPED").get("taskArns", [])
        if arns:
            for t in aws("ecs", "describe-tasks", "--cluster", a.cluster, "--tasks", *arns[:100]).get("tasks", []):
                at = t.get("stoppedAt")
                if at and datetime.fromisoformat(at.replace("Z", "+00:00")) >= start:
                    stopped.append(t.get("stoppedReason", "?"))
    except subprocess.CalledProcessError:
        stopped = None

    # --- critérios -------------------------------------------------------------------------------
    expected_events = a.rate * a.duration + (a.warmup * (min(a.rate, 200) + a.rate) / 2 if a.warmup else 0)
    sent = val("events_sent", "count", 0)
    dropped = val("dropped_iterations", "count", 0)
    exp_alerts = val("alerts_expected", "count", 0)
    rcv_alerts = val("alerts_received", "count", 0)
    dups = val("alerts_duplicated", "count", 0)
    svc = "alert_service_latency_ms{phase:steady}"
    p95, p99 = val(svc, "p(95)"), val(svc, "p(99)")
    age_vals = steady("age")
    age_tail = [v for t, v in cw.get("age", []) if t > steady_hi]
    dlq_max = max([max(window(cw.get(f"dlq{i}", []), start, end + timedelta(minutes=3)), default=0) for i in range(len(a.dlq))] or [0])
    ecs_cpu = stat(steady("ecs_cpu"), lambda v: sum(v) / len(v))
    rds_cpu = stat(steady("rds_cpu"), lambda v: sum(v) / len(v))

    def check(ok):
        return "ok" if ok else "FALHOU"

    rows = []  # (id, critério, limite, medido, status)
    rows.append(("C1", "Taxa de envio efetiva", "≥ 99% do planejado e 0 descartadas",
                 f"{sent:.0f} de {expected_events:.0f} ({100 * sent / expected_events:.1f}%), descartadas {dropped:.0f}" if expected_events else "n/a",
                 check(expected_events and sent >= 0.99 * expected_events and dropped == 0)))
    err = val("send_errors", "rate", 0)
    rows.append(("C2", "Erros de envio", "< 0,1%", f"{100 * err:.3f}%", check(err < 0.001)))
    rows.append(("C3", "Alertas recebidos ÷ esperados", "= 100%",
                 f"{rcv_alerts:.0f} de {exp_alerts:.0f}", check(exp_alerts > 0 and rcv_alerts == exp_alerts)))
    rows.append(("C4", "Alertas duplicados", "= 0", f"{dups:.0f}", check(dups == 0)))
    rows.append(("C5", "Latência de serviço p95", "< 500 ms", f"{p95:.1f} ms" if p95 is not None else "n/a", check(p95 is not None and p95 < 500)))
    rows.append(("C6", "Latência de serviço p99", "< 500 ms", f"{p99:.1f} ms" if p99 is not None else "n/a", check(p99 is not None and p99 < 500)))
    age_max = stat(age_vals, max)
    rows.append(("C7", "Idade da mensagem mais antiga em `transactions`", "< 5 s na janela; ≈ 0 ao fim do drain",
                 f"máx {age_max:.0f} s; fim {age_tail[-1]:.0f} s" if age_max is not None and age_tail else (f"máx {age_max:.0f} s" if age_max is not None else "sem dados"),
                 check(age_max is not None and age_max < 5 and (not age_tail or age_tail[-1] <= 1))))
    rows.append(("C8", "Mensagens nas DLQs", "0", f"máx {dlq_max:.0f} ({len(a.dlq)} filas)", check(dlq_max == 0)))
    rows.append(("C9", "CPU média do ECS", "< 75%", f"{ecs_cpu:.1f}%" if ecs_cpu is not None else "sem dados", check(ecs_cpu is not None and ecs_cpu < 75)))
    rows.append(("C10", "CPU média do RDS", "< 60%", f"{rds_cpu:.1f}%" if rds_cpu is not None else "sem dados", check(rds_cpu is not None and rds_cpu < 60)))
    rows.append(("C11", "Tasks do serviço paradas durante a execução", "0",
                 "n/a" if stopped is None else f"{len(stopped)}" + (f" ({'; '.join(sorted(set(stopped)))})" if stopped else ""),
                 "n/a" if stopped is None else check(not stopped)))

    failed = [r for r in rows if r[4] == "FALHOU"]
    verdict = "REPROVADO" if failed else "APROVADO"
    if dropped or (expected_events and sent < 0.99 * expected_events):
        verdict = "INVÁLIDO (o gerador não entregou a carga; corrija o gerador e repita)"

    # --- relatório -------------------------------------------------------------------------------
    def fmt(v, unit="", digits=1):
        return "n/a" if v is None else f"{v:.{digits}f}{unit}"

    lat = lambda name: {k: val(name, k) for k in ("med", "p(95)", "p(99)", "max")}
    L = []
    L.append(f"# Teste de carga AWS: {start.strftime('%Y-%m-%d')} ({a.rate:.0f} TPS)\n")
    if a.meta:
        L.append(f"- {a.meta}")
    L.append(f"- Janela da execução: {iso(start)} a {iso(end)} (UTC); medição (steady): {iso(steady_lo)} a {iso(steady_hi)}")
    L.append(f"- Planejado: {a.rate:.0f} TPS por {a.duration:.0f} s após {a.warmup:.0f} s de aquecimento\n")
    L.append(f"## Resultado: {verdict}\n")
    L.append("| Critério | Descrição | Limite | Medido | Status |\n|---|---|---|---|---|")
    for r in rows:
        L.append(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |")
    L.append("\n## Latência (ms), fase steady\n")
    L.append("| Métrica | p50 | p95 | p99 | max |\n|---|---|---|---|---|")
    for label, name in (("serviço (ingestedAt→publishedAt)", svc), ("e2e (k6)", "alert_e2e_latency_ms{phase:steady}")):
        d = lat(name)
        L.append(f"| {label} | {fmt(d['med'])} | {fmt(d['p(95)'])} | {fmt(d['p(99)'])} | {fmt(d['max'])} |")
    send = lat("send_latency_ms")
    L.append(f"| envio ao SQS (gerador) | {fmt(send['med'])} | {fmt(send['p(95)'])} | {fmt(send['p(99)'])} | {fmt(send['max'])} |")
    L.append("\n## Recursos na janela steady (média / máx.)\n")
    L.append("| Recurso | Média | Máx. |\n|---|---|---|")
    avg = lambda v: sum(v) / len(v) if v else None
    for label, qid, unit, scale in (
        ("ECS CPU (%)", "ecs_cpu", "", 1), ("ECS memória (%)", "ecs_mem", "", 1), ("RDS CPU (%)", "rds_cpu", "", 1),
        ("RDS conexões", "rds_conn", "", 1), ("RDS latência de escrita (ms)", "rds_wlat", "", 1000),
        ("SQS transactions: idade (s)", "age", "", 1), ("SQS transactions: visíveis", "visible", "", 1),
    ):
        v = [x * scale for x in steady(qid)]
        L.append(f"| {label} | {fmt(avg(v))} | {fmt(max(v) if v else None)} |")
    sent_sum = sum(steady("sent")) if steady("sent") else None
    del_sum = sum(steady("deleted")) if steady("deleted") else None
    L.append(f"\n- SQS `{a.queue}` na janela steady: enviadas {fmt(sent_sum, digits=0)}, apagadas {fmt(del_sum, digits=0)}")
    L.append(f"- SNS `{a.topic}`: publicadas {fmt(sum(steady('sns_pub')) if steady('sns_pub') else None, digits=0)}, falhas de entrega {fmt(sum(steady('sns_fail')) if steady('sns_fail') else None, digits=0)}")
    L.append("\n## Observações\n\n_(preencher: eventos relevantes, gargalo identificado, custo da execução)_\n")
    L.append("## Próximo passo\n\n_(repetir | corrigir X | subir para 2.000 TPS)_")

    text = "\n".join(L) + "\n"
    open(a.out, "w").write(text)
    print(text)
    return 1 if failed or verdict != "APROVADO" else 0


if __name__ == "__main__":
    sys.exit(main())

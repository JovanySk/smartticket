"""CLI: python -m smartticket.train [--data data/tickets.csv]"""
import argparse
from pathlib import Path

from .training import TARGETS, load_tickets, save, train

DATA_URL = ("https://huggingface.co/datasets/Tobi-Bueck/customer-support-tickets/resolve/main/"
            "dataset-tickets-multi-lang-4-20k.csv")


def main() -> None:
    ap = argparse.ArgumentParser(description="Train SmartTicket models")
    ap.add_argument("--data", type=Path, default=Path("data/tickets.csv"))
    ap.add_argument("--model", type=Path, default=Path("models/model.joblib"))
    ap.add_argument("--metrics", type=Path, default=Path("reports/metrics.json"))
    args = ap.parse_args()

    if not args.data.exists():
        import urllib.request
        args.data.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading dataset to {args.data} ...")
        urllib.request.urlretrieve(DATA_URL, args.data)

    df = load_tickets(args.data)
    result = train(df)
    save(result, args.model, args.metrics)

    print(f"Trained on {result.metrics['n_tickets']} English tickets (20% held out for evaluation)")
    print(f"{'target':<10}{'accuracy':>10}{'macro F1':>10}{'baseline F1':>13}")
    for t in TARGETS:
        m = result.metrics["targets"][t]
        print(f"{t:<10}{m['accuracy']:>10.3f}{m['macro_f1']:>10.3f}{m['baseline_macro_f1']:>13.3f}")


if __name__ == "__main__":
    main()

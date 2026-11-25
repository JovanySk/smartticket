"""Development-only seed data: demo staff accounts and sample tickets.

Only used when SMARTTICKET_ENV=dev. Sample tickets go through the real model, so every confidence,
routing decision and explanation shown in the panel is computed, not hard-coded.
"""
from __future__ import annotations

from .db import Store, ago
from .inference import Classifier
from .security import hash_password

DEMO_USERS = [
    # email, name, role, area, password
    ("admin@smartticket.test", "Admin Demo", "admin", None, "Admin123!"),
    ("agente@smartticket.test", "Ana Robles", "agente", "IT Support", "Agente123!"),
]

# (minutes ago, subject, body). Written like real customer tickets; content stays in English because the
# model was trained on English tickets.
DEMO_TICKETS = [
    (3, "When is my vacation paid?", "Hi, I booked vacation for December and want to know if it is paid before I leave or in the normal pay cycle. Thanks."),
    (8, "October invoice never arrived", "I did not receive the invoice for October. Can you send it again? Our accounting team needs it this week."),
    (12, "VPN drops every 10 minutes", "Our VPN connection keeps dropping every ten minutes for everyone in the office. We have to reconnect constantly."),
    (25, "Switch my plan to annual", "We would like to move from the monthly plan to the annual plan. What happens with the days already paid?"),
    (40, "Charged for an item I returned", "I returned the headphones two weeks ago but I was still charged. The tracking shows the package was delivered to you."),
    (61, "Cannot download my certificate", "I am trying to download my certificate from the portal but the button does nothing. I need it for tomorrow."),
    (75, "Question about your data retention", "How long do you keep customer records after we close an account? Our compliance team is asking."),
    (95, "Login page keeps loading", "Since this morning the login page just keeps loading and never lets me in. I cleared the cache already."),
    (120, "Need help with my order", "Hello, I placed an order last week and I have not heard anything since. Could someone check what is going on?"),
    (150, "Exchange for a different size", "The jacket I ordered is too small. Can I exchange it for a large instead of returning it?"),
    (190, "Printer on floor 3 offline", "The shared printer on the third floor shows offline for every laptop. Restarting it did not help."),
    (240, "Partnership proposal", "We are a small agency and would like to discuss a partnership to resell your product to our clients."),
    (6, "Charged twice for my subscription", "Hello, I was billed twice for my monthly subscription this month. Both payments show on my credit card statement. Please refund the duplicate payment."),
    (15, "Refund request for my last purchase", "I would like to request a refund for my last purchase. The product did not meet our expectations and we returned it within the trial period."),
    (33, "Server outage in production", "Our production server is down and the application is not responding for any user. This is critical, please help immediately."),
    (52, "Update billing address", "Please update the billing address on our account and send a corrected invoice for this month."),
    (88, "Scheduled maintenance window", "Is there scheduled maintenance this weekend? We saw a notice about a service outage on Saturday night."),
    (130, "Enterprise pricing for 200 seats", "We are evaluating your platform for a team of 200 people. Does the enterprise plan include SSO? Could you send pricing?"),
    (170, "Payment failed with my card", "My payment failed three times with the same credit card even though the card works elsewhere. Please check the billing."),
    (210, "Return label not received", "I requested a return for my order but never received the return label by email. How do I send the item back?"),
]


def seed_users(store: Store) -> None:
    for email, name, role, area, password in DEMO_USERS:
        if store.user_by_email(email) is None:
            store.create_user(email, name, role, hash_password(password), area=area)


def seed_tickets(store: Store, clf: Classifier, threshold: float) -> None:
    if store.counts()["total"] or not clf.available:
        return
    for minutes, subject, body in sorted(DEMO_TICKETS, key=lambda t: -t[0]):
        pred = clf.predict(subject, body, threshold)
        store.add_ticket(subject, body, "demo", pred, created=ago(minutes))

# DNS Verifier — Chrome Extension

A browser-based DNS validation tool built for Klaviyo's Support and CNX teams. 
Automates domain authentication checks that were previously done manually across 
multiple tools, and generates escalation-ready summaries in a single click.

---

## Background

Working in Klaviyo's Deliverability & Compliance team, I repeatedly observed the 
same manual process: agents switching between nslookup, MXToolbox, DMARCIAN, and 
internal dashboards to validate a customer's sending domain setup before escalating 
a case. It was slow, error-prone, and produced inconsistent outputs.

I built this tool independently — without a brief or directive — using AI-assisted 
development (Claude, ChatGPT) to accelerate the JavaScript I hadn't written before. 
It is now adopted globally across Klaviyo's Support and CNX teams, documented in the 
internal knowledge base, and formally approved by the DelivOps team.

---

## What It Does

- Detects sending infrastructure type: **SendGrid**, **KMTA**, or hybrid
- Performs live DNS lookups for **SPF**, **DKIM**, **DMARC**, and **BIMI** records
- Cross-checks DNS propagation across multiple resolvers
- Flags misconfigurations, missing records, and policy weaknesses
- Generates a **formatted escalation summary** ready to paste into a Zendesk ticket or CNX macro

---

## Versions

| Version | Description |
|---------|-------------|
| `standard` | For general Support use — validates sending domain and flags issues |
| `cnx` | Extended version for CNX team — includes additional infrastructure checks and macro-formatted output |

---

## Tech Stack

- JavaScript (Vanilla)
- Chrome Extension APIs (Manifest V3)
- DNS-over-HTTPS (DoH) for live record lookups
- HTML / CSS

---

## Installation (Local / Developer Mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked**
5. Select the `/standard` or `/cnx` folder

---

## How It Was Built

This project was developed using AI-assisted coding — I used Claude and ChatGPT 
to help write and debug JavaScript I was learning as I built. The problem definition, 
architecture decisions, testing, and deployment were all mine. The AI acted as a 
pair programmer, not an author.

This is the approach I apply to all internal tooling: identify a real friction point, 
prototype quickly using available AI tools, iterate based on team feedback, and ship 
something that works in production.

---

## Status

Deployed and in active use across Klaviyo's global Support and CNX teams.

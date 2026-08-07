# Delivery tracking: a short guide

Three new screens. Here is what each one shows you.


## 1. Delivery page

In the left menu under Analytics. Use the shop and date filters as usual.

Four numbers at the top:

- **Median days to delivery.** The typical wait, from order placed to parcel
  with the customer.
- **On-time rate.** How many delivered orders met the promise you set.
- **Late right now.** Past their promise and still not delivered. This is your
  to-do list.
- **No tracking.** We expected a parcel and do not have one. Usually the
  warehouse never booked it.

If a number is not known yet, you see a dash, never a zero. A zero would look
like good news when the truth is that we have no data.

Underneath:

- **In the warehouse, and In transit.** The wait split in two. This tells you
  whether to talk to the warehouse or to Bring.
- **How long orders took.** A bar per day count, so you see the slow tail.
- **By country.** Median days and on-time rate for each country.
- **Late list.** Every late order, with links to the order and to Bring.
- **Unlinked parcels.** Tracking numbers no order claimed. If this grows,
  something is wrong with the warehouse file.
- **Recent imports.** Every file read, and how many parcels it linked.


## 2. Delivery column on Orders

One new column. Each order says one of:

- **3 days.** Delivered. Red if it was late.
- **In transit, day 4.** On its way.
- **At the warehouse, day 2.** Not handed to Bring yet.
- **Not shipped yet.** No parcel at all. Red once past the promise.
- **Returned** or **Cancelled.**
- **A dash.** Not judged. Refunded, or before tracking started, or the shop is
  not tracked. Hover to see which.


## 3. Delivery settings

In the left menu under Setup.

**Bring.** Your Mybring email and API key. Bring calls the email an API UID,
but it is just your login. Press Test connection after saving.

**Slack.** The webhook address for alerts. Create it at
https://api.slack.com/messaging/webhooks and paste it here. Press Send test
message once so you know what an alert looks like.

**Delivery promises.** Days per country. Business days by default, so a Friday
order with a three day promise is not late on Monday. Changing a promise never
rewrites past figures.

**Which shops are tracked.** One date per shop. Leave it blank and that shop is
not tracked at all. This is the on and off switch. The date also means do not
judge anything older, so switching on will not flood Slack with old orders.

**Recent imports.** A record of every file read.


## Press both test buttons

They are the only way to tell the difference between nothing is late this week
and the alerting broke three weeks ago.


## To switch it on we still need

1. One sample file from the warehouse.
2. One tracking number for a parcel the warehouse booked.
3. Your delivery promise in days, per country.

Until then it runs but says Bring is not connected. Nothing breaks.

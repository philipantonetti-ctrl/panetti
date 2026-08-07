# Delivery tracking: how the three screens work

This covers what was added, what each number means, and what to do with it.

There are three screens. Delivery, a new column on Orders, and Delivery settings.


## 1. Delivery page

Found in the left menu under Analytics, called Delivery.

It uses the same shop and date filters as every other page, so you can look at
one shop or all of them, this month or last year.

### The four numbers at the top

**Median days to delivery**
The typical wait, from the moment the order is placed to the moment the parcel
is with the customer. It is a median rather than an average on purpose. One
parcel stuck in customs for a month would drag an average somewhere useless.
The median tells you what an ordinary order actually looks like.

**On-time rate**
The share of delivered orders that arrived within the promise you set for that
country. It only counts orders that had a promise in force. If some did not,
the page says how many it left out rather than quietly including them.

**Late right now**
Orders that are past their promise and still not with the customer. This is a
list of things to chase, not a history. An order that arrived late is not in
here, because there is nothing left to do about it. It still counts against
your on-time rate.

**No tracking**
Orders where we expected a parcel and do not have one. Usually this means the
warehouse never booked it, which is worth knowing quickly.

### One rule that runs through the whole page

When a number is not known, the page shows a dash, never a zero.

A zero would read as "delivered same day" or "nothing is late". Both would be
lies when the truth is "we do not have the data yet". If you see a dash, it
means we genuinely do not know, and that is deliberate.

### Below the four numbers

**In the warehouse, and In transit**
The total wait split in two. How long the warehouse held the order before
handing it to Bring, and how long Bring had it after that.

This is the most useful number on the page. If deliveries are slow, this tells
you which half to do something about. Slow warehouse days is a conversation
with the warehouse. Slow transit days is a conversation with Bring.

**How long delivered orders took**
A bar for each day count, so you can see the spread. The median tells you the
middle. This tells you the tail, which is where complaints come from.

**By country**
Delivered count, median days and on-time rate for each destination country.
This matches how the promises are set, so you can see at a glance which country
is the problem.

**The late list**
Every order currently past its promise. Order number, shop, country, how many
days over, what the promise was, and what is actually happening to the parcel.
Each row links to the order, and to Bring's own tracking page for the parcel.

**Unlinked parcels**
Tracking numbers we have that no order claimed. If this number grows, something
is wrong with the file from the warehouse.

**Recent imports**
Every warehouse file the system has read, with how many parcels it found and
how many it managed to link.

Those last two sections exist for one reason. If the link between orders and
parcels quietly stops working, nothing looks broken. The page just looks like a
quiet week. These two numbers are how you notice.

If no shop is set up for tracking yet, the whole page is replaced by a short
message and a link to the settings, rather than showing you a screen full of
zeros that mean nothing.


## 2. Delivery column on the Orders page

One new column on the orders list you already use. Each order gets a plain
sentence rather than a code.

**3 days**
Delivered. Shown in red if it broke the promise.

**In transit, day 4**
On its way. The day count updates on its own, it is not a stored number.

**At the warehouse, day 2**
The label exists but the warehouse has not handed the parcel over yet.

**Not shipped yet**
No parcel at all. Turns red once the order is past its promise.

**Returned, or Cancelled**
The parcel came back, or the delivery was called off.

**A dash**
An order we do not judge. Either it was refunded, or it was placed before you
switched tracking on for that shop, or that shop is not tracked at all. Hover
over the dash and it tells you which.

That last one matters. "This shop is not tracked" and "this order has not
shipped" mean completely different things, so they never look the same.


## 3. Delivery settings

Found in the left menu under Setup, called Delivery settings.

Five sections, in the order you would set them up.

### Bring

Your Mybring account email, your API key, and a client URL.

Note that Bring calls the first one an API UID, but it is simply the email
address you log into Mybring with. There is nothing else to find.

There is a Test connection button. Press it after saving. It tells you straight
away whether Bring accepted your details.

The section also shows when the system last successfully checked your parcels,
and any error it hit.

### Slack

The webhook address where delivery alerts should post. You create it yourself
at https://api.slack.com/messaging/webhooks and paste the address here.

There is a Send test message button. Press it and a message appears in the
channel. Do this once so you know what a real alert will look like.

Slack errors are shown separately from Bring errors, so a problem with one can
never hide a problem with the other.

### Delivery promises

One row per country. Country, number of days, whether those are business days,
and the date the promise came into force.

Business days is on by default. A Friday order with a three day promise is not
late on Monday.

Changing a promise today never rewrites last month's figures. The old promise
stays in force for orders placed while it applied, so your history stays
honest.

A row with a star covers every country that does not have its own row.

### Which shops are tracked

One date per shop.

Leaving it blank means that shop is not delivery tracked at all. Its orders
never alert and never enter any of the figures. This is the on and off switch.

Setting a date also means "do not judge anything older than this". So when you
switch tracking on, you will not get a flood of alerts about orders from months
ago.

### Recent imports

A record of every warehouse file the system has read, most recent first.


## Why the two test buttons matter

Without them, there is no way to tell the difference between "nothing is late
this week" and "the alerting broke three weeks ago and nobody noticed".

Press both once when you set things up. If an alert ever stops arriving, press
them again. They are the fastest way to find out whether the quiet is real.


## What is still needed to switch it on

1. One sample file from the warehouse, so the system can be taught to read it.

2. One tracking number for a parcel the warehouse booked, so we can confirm we
   are allowed to see their shipments.

3. Your delivery promises, per country.

Until then the system runs but reports that Bring is not connected, and says so
on the settings page. Nothing breaks. It simply does not track yet.

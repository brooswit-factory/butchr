/**
 * local/ui — the Coming soon page at `/coming-soon`: what butchr does that
 * this web app can't show or change yet (`view-model/coming-soon.ts`), and
 * where each lives today. The user asked for it.
 */
import { Heading, Text } from "@launchpad-ui/components";
import { COMING_SOON, ON_PURPOSE, type ComingSoonItem } from "../view-model/coming-soon.js";
import "../components/status/Status.css";

function Item({ item }: { item: ComingSoonItem }) {
  return (
    <li className="cs-item">
      <div>
        <Text elementType="p" className="cs-item__title">
          {item.title}
        </Text>
        <Text elementType="p" size="small" className="st-muted">
          {item.detail}
        </Text>
      </div>
      <Text elementType="p" size="small" className="cs-item__today">
        <span className="st-muted">Today: </span>
        <code>{item.today}</code>
      </Text>
    </li>
  );
}

export function ComingSoonRoute() {
  return (
    <section aria-labelledby="coming-soon-heading" className="st-page cs-page">
      <div>
        <Heading id="coming-soon-heading" size="small">
          Coming soon
        </Heading>
        <Text elementType="p" size="small" className="st-muted">
          What butchr does that this web app can't show or change yet, and where each one lives today.
        </Text>
      </div>
      {COMING_SOON.map((g) => (
        <section key={g.id} className="st-card" aria-labelledby={`cs-${g.id}`} data-testid={`cs-group-${g.id}`}>
          <header className="st-card__header">
            <Heading level={2} id={`cs-${g.id}`} className="st-card__title">
              {g.title}
            </Heading>
            <Text size="small" className="st-muted">
              {g.items.length} item{g.items.length === 1 ? "" : "s"}
            </Text>
          </header>
          <ul className="cs-items">
            {g.items.map((item) => (
              <Item key={item.title} item={item} />
            ))}
          </ul>
        </section>
      ))}
      <section className="st-card cs-card--muted" aria-labelledby="cs-on-purpose" data-testid="cs-on-purpose">
        <header className="st-card__header">
          <Heading level={2} id="cs-on-purpose" className="st-card__title">
            Staying outside the web app on purpose
          </Heading>
        </header>
        <ul className="cs-items">
          {ON_PURPOSE.map((item) => (
            <Item key={item.title} item={item} />
          ))}
        </ul>
      </section>
    </section>
  );
}

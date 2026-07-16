// Public URL helpers for booking links.

export function appBaseUrl(): string {
	return (process.env.NEXT_PUBLIC_APP_URL || 'https://app.rocketbooks.ai').replace(/\/$/, '');
}

export function publicBookingUrl(slug: string): string {
	return `${appBaseUrl()}/book/${encodeURIComponent(slug)}`;
}

export function eventTypeUrl(slug: string, eventSlug: string): string {
	return `${appBaseUrl()}/book/${encodeURIComponent(slug)}/${encodeURIComponent(eventSlug)}`;
}

export function cancelUrl(token: string): string {
	return `${appBaseUrl()}/book/cancel/${encodeURIComponent(token)}`;
}

export interface SearchHit {
  id: string;
  title: string;
  detail: string | null;
  href: string;
}

export interface SearchResults {
  inventory: SearchHit[];
  shopping: SearchHit[];
  meals: SearchHit[];
}

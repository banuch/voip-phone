/** Builds a parameterised WHERE clause. `?` in each fragment becomes the next $n. */
export class SqlWhere {
  readonly params: unknown[];
  private readonly parts: string[] = [];

  constructor(initialParams: unknown[] = []) {
    this.params = [...initialParams];
  }

  add(fragment: string, ...values: unknown[]): this {
    let i = 0;
    const sql = fragment.replace(/\?/g, () => {
      this.params.push(values[i++]);
      return `$${this.params.length}`;
    });
    this.parts.push(sql);
    return this;
  }

  /** Next placeholder for use outside the WHERE (e.g. LIMIT). */
  param(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }

  get sql(): string {
    return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : '';
  }

  get and(): string {
    return this.parts.length ? `AND ${this.parts.join(' AND ')}` : '';
  }
}

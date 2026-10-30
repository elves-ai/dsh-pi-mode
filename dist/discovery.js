import { scopeChainOf } from '@deepseek-ai/dsh-scope';
/** Each model request fixes the callable names until the next request assembly. */
export class ProgressiveToolSelection {
    ctx;
    activatedNames;
    eager;
    requests = new WeakMap();
    validatedEagerNames = false;
    constructor(ctx, config, activatedNames) {
        this.ctx = ctx;
        this.activatedNames = activatedNames;
        this.eager = new Set(['tool_search', ...config.eagerTools]);
    }
    /**
     * Filter existing schemas without widening registry restrictions.
     * @param schemas - schemas assembled by the Host.
     * @param context - caller and optional running-turn signal; diagnostics do not change admission.
     * @returns eager and durably discovered schemas.
     */
    select(schemas, context) {
        if (!this.validatedEagerNames) {
            const scopes = [...scopeChainOf(context.scope), undefined];
            const missing = [...this.eager].filter(name => !scopes.some(scope => this.ctx.tools.get(name, scope) !== undefined));
            if (missing.length > 0)
                throw new Error(`eagerTools names unregistered tools: ${missing.join(', ')}`);
            this.validatedEagerNames = true;
        }
        const active = new Set([...this.eager, ...this.activatedNames(context.agent)]);
        if (context.agent !== undefined && context.signal !== undefined) {
            this.requests.set(context.agent, active);
        }
        return schemas.filter(tool => active.has(tool.name));
    }
    /**
     * Deny tools not activated when the current request was assembled.
     * @param exec - Host-validated execution; all other Host guards still apply.
     * @returns an actionable denial, or undefined to delegate admission.
     */
    deny(exec) {
        const active = exec.agent === undefined ? this.eager : this.requests.get(exec.agent) ?? this.eager;
        return active.has(exec.name) ? undefined
            : `search for \`${exec.name}\` with tool_search first; call it in your next response after its schema is available`;
    }
}

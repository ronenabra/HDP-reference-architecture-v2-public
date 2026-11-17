'use strict';

/**
 * OAuth endpoint-role authorization helpers.
 *
 * Transport authentication and endpoint authorization are intentionally
 * separate: a trusted mTLS peer still needs a grant for the operation it is
 * attempting to invoke.
 */

function grantedScopes(user) {
    const value = user?.scope;
    if (Array.isArray(value)) return new Set(value);
    if (typeof value !== 'string') return new Set();
    return new Set(value.split(/\s+/).filter(Boolean));
}

function createRequiredScopeMiddleware(requiredScope) {
    if (!requiredScope) throw new Error('requiredScope is required');
    return (req, res, next) => {
        if (grantedScopes(req.user).has(requiredScope)) return next();
        return res.status(403).json({
            error: 'forbidden',
            error_description: `Client is not authorized for ${requiredScope}`
        });
    };
}

module.exports = {
    createRequiredScopeMiddleware,
    grantedScopes
};

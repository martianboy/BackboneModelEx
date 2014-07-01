define(['underscore', 'backbone'], function(_, Backbone) {
"use strict";

var methodMap = {
	'create': 'POST',
	'update': 'PUT',
	'patch':  'PATCH',
	'delete': 'DELETE',
	'read':   'GET'
};

_.resultWithContext = function(object, property, context) {
	if (object == null) return void 0;
	var value = object[property];
	return _.isFunction(value) ? value.call(context || object) : value;
};

_.resultWithParams = function(object, property, params) {
	if (object == null) return void 0;
	var value = object[property];
	return _.isFunction(value) ? value.apply(object, params) : value;
};

var ExtendedModel = Backbone.Model.extend({
	constructor: function(attributes, options) {
		this._previousAttributes = {};
		this.changed = {};

		Backbone.Model.call(this, attributes, options);
		this._previousAttributes = _.clone(this.attributes);

		if (this.computed)
			_.forEach(this.computed, function(value, key) {
				if (_.isFunction(value))
					Object.defineProperty(this, key, { get: value });
				else
					Object.defineProperty(this, key, value);
			}.bind(this));

		this.delegateEvents();
	},

	delegateEvents: function(events) {
		if (!(events || (events = _.result(this, 'events')))) return this;

		for (var key in events) {
			var method = events[key];
			if (!_.isFunction(method)) method = this[events[key]];
			if (!method) continue;

			this.on(key, method, this);
		}
		return this;
	},

	set: function(key, val, options) {
		var attr, attrs, unset, changes, silent, changing, prev, current;
		if (key == null) return this;

		// Handle both `"key", value` and `{key: value}` -style arguments.
		if (typeof key === 'object') {
			attrs = key;
			options = val;
		} else {
			(attrs = {})[key] = val;
		}

		options || (options = {});

		// Run validation.
		if (!this._validate(attrs, options)) return false;

		// Extract attributes and options.
		unset           = options.unset;
		silent          = options.silent;
		changes         = [];
		changing        = this._changing;
		this._changing  = true;

		current = this.attributes, prev = this._previousAttributes;

		// Check for changes of `id`.
		if (this.idAttribute in attrs) this.id = attrs[this.idAttribute];

		// For each `set` attribute, update or delete the current value.
		for (attr in attrs) {
			var excludedFields = _.result(this.excludedFields, 'set');
			if (_.contains(excludedFields, attr))
				continue;

			val = attrs[attr];
			if (attr in this.transform)
				val = this.transform[attr].call(null, val);

			if (!_.isEqual(current[attr], val)) changes.push(attr);
			if (!_.isEqual(prev[attr], val)) {
				this.changed[attr] = val;
			} else {
				delete this.changed[attr];
			}
		  	unset ? delete current[attr] : current[attr] = val;
		}

		// Trigger all relevant attribute changes.
		if (!silent) {
	  		if (changes.length) this._pending = options;
			for (var i = 0, l = changes.length; i < l; i++) {
				this.trigger('change:' + changes[i], this, current[changes[i]], options);
			}
		}

		// You might be wondering why there's a `while` loop here. Changes can
		// be recursively nested within `"change"` events.
		if (changing) return this;
		if (!silent) {
			while (this._pending) {
				options = this._pending;
				this._pending = false;
				this.trigger('change', this, options);
			}
		}
		this._pending = false;
		this._changing = false;
		return this;
	},

	toJSON: function(options) {
		return _.omit(
			Backbone.Model.prototype.toJSON.apply(this, arguments),
			_.resultWithContext(this.excludedFields, 'save', this) || []
		);
	},
	parse: function(data, options) {
		return _.omit(data, this.excludedFields.fetch);
	},

	save: function(key, val, options) {
		var attrs, method, xhr, patch, attributes = this.attributes;

		// Handle both `"key", value` and `{key: value}` -style arguments.
		if (key == null || typeof key === 'object') {
			attrs = key;
			options = val;
		} else {
			(attrs = {})[key] = val;
		}

		options = _.extend({validate: true}, options);

		// If we're not waiting and attributes exist, save acts as
		// `set(attr).save(null, opts)` with validation. Otherwise, check if
		// the model will be valid when the attributes, if any, are set.
		if (attrs && !options.wait) {
			if (!this.set(attrs, options)) return false;
		} else {
			if (!this._validate(attrs, options)) return false;
		}

		// Set temporary attributes if `{wait: true}`.
		if (attrs && options.wait) {
			this.attributes = _.extend({}, attributes, attrs);
		}

		// After a successful server-side save, the client is (optionally)
		// updated with the server-side state.
		if (options.parse === void 0) options.parse = true;
		var model = this;
		var success = options.success;
		options.success = function(resp) {
			// Ensure attributes are restored during synchronous saves.
			model.attributes = attributes;
			var serverAttrs = model.parse(resp, options);
			if (options.wait) serverAttrs = _.extend(attrs || {}, serverAttrs);
			if (_.isObject(serverAttrs) && !model.set(serverAttrs, options)) {
				return false;
			}
			if (success) success(model, resp, options);
			model.trigger('sync', model, resp, options);
		};
		wrapError(this, options);

		method = this.isNew() ? 'create' : 'update';

		if (method === 'update')
			this.trigger('before:update', this, options);
		else
			this.trigger('before:create', this, options);

		this.trigger('before:save', this, method, options);

		var patchFields = _.resultWithParams(this, 'patchFields', [options]);
		patch = _.isEmpty(_.difference(_.keys(this.changed), patchFields));

		if (method === 'update')
			if (options.patch || patch)
				options.attrs = this.changed;

		xhr = this.sync(method, this, options);

		// Restore attributes.
		if (attrs && options.wait) this.attributes = attributes;

		return xhr.always(function() {
			this._previousAttributes = _.clone(this.attributes);
			this.changed = {};
		}.bind(this));
	},

	sync: function(method, model, options) {
		var type = methodMap[method];

		// Default options, unless specified.
		options || (options = {});

		// Default JSON-request options.
		var params = {type: type, dataType: 'json'};

		// Ensure that we have a URL.
		if (!options.url)
			params.url = _.resultWithParams(model, 'url', [options]) || urlError();

		// Ensure that we have the appropriate request data.
		if (options.data == null && model && (method === 'create' || method === 'update' || method === 'patch')) {
			params.contentType = 'application/json';
			params.data = JSON.stringify(options.attrs || model.toJSON(options));
		}

		// Don't process data on a non-GET request.
		if (params.type !== 'GET')
			params.processData = false;

		// Make the request, allowing the user to override any Ajax options.
		var xhr = options.xhr = Backbone.ajax(_.extend(params, options));
		model.trigger('request', model, xhr, options);
		return xhr;
	}
});

var wrapError = function(model, options) {
	var error = options.error;
	options.error = function(resp) {
		if (error) error(model, resp, options);
		model.trigger('error', model, resp, options);
	};
};

return ExtendedModel;

});

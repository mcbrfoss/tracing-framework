/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Navigation bar control.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

goog.provide('wtf.app.ui.nav.FpsStatsBox');
goog.provide('wtf.app.ui.nav.GcStatsBox');
goog.provide('wtf.app.ui.nav.StatsBox');

goog.require('goog.soy');
goog.require('wtf.app.ui.nav.statsbox');
goog.require('wtf.ui.Control');
goog.require('wtf.ui.Painter');



/**
 * Statistics box base control.
 * Provides a histogram renderer and a table for data.
 * @param {!Element} parentElement Element to display in.
 * @param {!goog.dom.DomHelper} dom DOM helper.
 * @constructor
 * @extends {wtf.ui.Control}
 */
wtf.app.ui.nav.StatsBox = function(parentElement, dom) {
  goog.base(this, parentElement, dom);

  /**
   * Numbers <table>.
   * @type {!Element}
   * @private
   */
  this.table_ = this.getChildElement(goog.getCssName('numbersTable'));

  var canvas = this.getChildElement(goog.getCssName('graphCanvas'));
  var paintContext = new wtf.ui.Painter(canvas);
  this.setPaintContext(paintContext);
};
goog.inherits(wtf.app.ui.nav.StatsBox, wtf.ui.Control);


/**
 * @override
 */
wtf.app.ui.nav.StatsBox.prototype.createDom = function(dom) {
  return /** @type {!Element} */ (goog.soy.renderAsFragment(
      wtf.app.ui.nav.statsbox.control, undefined, undefined, dom));
};


/**
 * @override
 */
wtf.app.ui.nav.StatsBox.prototype.layoutInternal = function() {
  goog.base(this, 'layoutInternal');
};


/**
 * Updates the contents of the numbers table.
 * @param {!Array.<{key: string, value: string|number}>} rows Rows data.
 * @protected
 */
wtf.app.ui.nav.StatsBox.prototype.updateNumbers = function(rows) {
  var dom = this.getDom();

  // TODO(benvanik): faster clear?
  dom.setTextContent(table, '');

  for (var n = 0; n < rows.length; n++) {
    var tr = goog.soy.renderAsFragment(
        wtf.app.ui.nav.statsbox.numbersRow, {
          key: rows[n].key,
          value: rows[n].value
        }, undefined, dom)
    dom.appendChild(table, tr);
  }
};



/**
 * A stats box for frames.
 * @param {!wtf.db.Database} db Database.
 * @param {!Element} parentElement Element to display in.
 * @param {!goog.dom.DomHelper} dom DOM helper.
 * @constructor
 * @extends {wtf.app.ui.nav.StatsBox}
 */
wtf.app.ui.nav.FpsStatsBox = function(db, parentElement, dom) {
  goog.base(this, parentElement, dom);

  /**
   * Database.
   * @type {!wtf.db.Database}
   * @private
   */
  this.db_ = db;
};
goog.inherits(wtf.app.ui.nav.FpsStatsBox, wtf.app.ui.nav.StatsBox);



/**
 * A stats box for GC events.
 * @param {!wtf.db.Database} db Database.
 * @param {!Element} parentElement Element to display in.
 * @param {!goog.dom.DomHelper} dom DOM helper.
 * @constructor
 * @extends {wtf.app.ui.nav.StatsBox}
 */
wtf.app.ui.nav.GcStatsBox = function(db, parentElement, dom) {
  goog.base(this, parentElement, dom);

  /**
   * Database.
   * @type {!wtf.db.Database}
   * @private
   */
  this.db_ = db;
};
goog.inherits(wtf.app.ui.nav.GcStatsBox, wtf.app.ui.nav.StatsBox);

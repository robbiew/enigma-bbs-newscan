/* jslint node: true */
'use strict';

// ENiGMA½
const MenuModule = require('../../core/menu_module.js').MenuModule;
const ViewController = require('../../core/view_controller.js').ViewController;
const messageArea = require('../../core/message_area.js');

// deps
const async = require('async');

exports.moduleInfo = {
    name: 'Configure Newscan Areas',
    desc: 'Allow users to configure which message areas are scanned by Newscan',
    author: 'j0hnny a1pha',
};

exports.getModule = class ConfigureNewscanModule extends MenuModule {
    constructor(options) {
        super(options);

        this.currentIndex = 0;
        this.listHeight = 11;
        this.listWidth = 65;
        this.listStartRow = 6;
        this.listStartCol = 5;
        this.availableAreas = [];

        // Use standard menu methods pattern
        this.menuMethods = {
            done: (formData, extraArgs, cb) => {
                return this.prevMenu(cb);
            },
            selectArea: (formData, extraArgs, cb) => {
                this.toggleCurrentArea();
                return cb(null);
            }
        };
    }

    mciReady(mciData, cb) {
        super.mciReady(mciData, err => {
            if (err) {
                return cb(err);
            }

            const self = this;

            async.series([
                function prepareViewController(callback) {
                    return self.prepViewController('main', 0, mciData.menu, callback);
                },

                function loadAreas(callback) {
                    return self.loadAvailableAreas(callback);
                },

                function setupMenuView(callback) {
                    const vm1 = self.viewControllers.main.getView(1);
                    if (!vm1) {
                        return callback(new Error('VM1 view not found'));
                    }

                    // Update area display objects
                    self.updateAreaListObjects();

                    // Set items for the vertical menu
                    vm1.setItems(self.availableAreas.map((area, index) => ({
                        text: area.text,
                        data: index
                    })));

                    vm1.setFocusItemIndex(0);

                    // Listen for navigation updates
                    vm1.on('index update', (newIndex) => {
                        self.currentIndex = newIndex;
                        self.updateStatus();
                    });

                    self.updateStatus();

                    return callback(null);
                }
            ], err => {
                if (err) {
                    self.client.log.error({ error: err.message }, 'Error loading newscan config');
                }
                return cb(err);
            });
        });
    }

    toggleCurrentArea() {
        try {
            if (this.currentIndex >= this.availableAreas.length) return;

            const area = this.availableAreas[this.currentIndex];
            let newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            let areaTagsArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            const areaIndex = areaTagsArray.indexOf(area.areaTag);
            let isNowSelected;
            if (areaIndex === -1) {
                // Add to newscan
                areaTagsArray.push(area.areaTag);
                isNowSelected = true;
            } else {
                // Remove from newscan
                areaTagsArray.splice(areaIndex, 1);
                isNowSelected = false;
            }

            // Save the updated newscan tags to memory
            this.client.user.properties['NewScanMessageAreaTags'] = areaTagsArray.join(',');

            // Persist the property to database immediately
            this.client.user.persistProperty('NewScanMessageAreaTags', areaTagsArray.join(','), (err) => {
                if (err) {
                    this.client.log.error({ error: err.message }, 'Failed to persist NewScanMessageAreaTags');
                } else {
                    this.client.log.debug('NewScanMessageAreaTags persisted successfully');
                }
            });

            // Update the internal data so it persists when VM1 redraws
            this.updateAreaListObjects();

            // Update VM1's internal item data
            const vm1 = this.viewControllers.main.getView(1);
            if (vm1 && vm1.items[this.currentIndex]) {
                // Update the VM1 item with the new text
                vm1.items[this.currentIndex].text = this.availableAreas[this.currentIndex].text;

                // Force VM1 to redraw just this item properly
                vm1.invalidateRenderCache();
                const item = vm1.items[this.currentIndex];
                if (item.row) {
                    // Let VM1 redraw the item with proper colors
                    vm1.drawItem(this.currentIndex);
                }
            }

            this.updateStatus();

        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in toggleCurrentArea');
        }
    }

    loadAvailableAreas(cb) {
        try {
            this.availableAreas = [];

            // Get available conferences
            const availableConfs = messageArea.getAvailableMessageConferences(this.client);

            Object.keys(availableConfs).forEach(confTag => {
                if (confTag === 'system_internal') {
                    return; // Skip system internal
                }

                const conf = messageArea.getMessageConferenceByTag(confTag);
                const confName = conf ? conf.name : confTag;

                // getAvailableMessageAreasByConfTag returns an OBJECT, not an array
                const areasInConf = messageArea.getAvailableMessageAreasByConfTag(confTag, {
                    client: this.client
                });

                if (areasInConf) {
                    // Iterate over the object keys (area tags)
                    Object.keys(areasInConf).forEach(areaTag => {
                        const area = areasInConf[areaTag];
                        this.availableAreas.push({
                            areaTag: areaTag,
                            confTag: confTag,
                            name: area.name || areaTag,
                            desc: area.desc || '',
                            confName: confName,
                            text: '' // Will be set in updateAreaListObjects
                        });
                    });
                }
            });

            return cb(null);
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error loading available areas');
            return cb(error);
        }
    }

    updateAreaListObjects() {
        try {
            const newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            const newscanArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            // Define exact column positions and widths to match the art
            const layout = {
                indicator: { start: 0, width: 1 },
                conference: { start: 2, width: 8 },
                areaName: { start: 10, width: 22 },
                description: { start: 35, width: 37 }
            };

            this.availableAreas.forEach((area, index) => {
                const isSelected = newscanArray.includes(area.areaTag);

                // Create a fixed-width string buffer
                const lineLength = layout.description.start + layout.description.width;
                let line = ' '.repeat(lineLength);

                // Position each field at exact columns
                line = this.placeTextAtPosition(line, isSelected ? '*' : ' ', layout.indicator.start, layout.indicator.width);
                line = this.placeTextAtPosition(line, area.confName || area.confTag || '', layout.conference.start, layout.conference.width);
                line = this.placeTextAtPosition(line, area.name || area.areaTag, layout.areaName.start, layout.areaName.width);
                line = this.placeTextAtPosition(line, area.desc || '', layout.description.start, layout.description.width);

                area.text = line;
            });
        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in updateAreaListObjects');
        }
    }

    // Helper to place text at exact position with truncation
    placeTextAtPosition(line, text, startPos, maxWidth) {
        if (!text) text = '';
        text = String(text);

        // Truncate with ellipsis if needed
        if (text.length > maxWidth) {
            if (maxWidth <= 3) {
                text = text.substring(0, maxWidth);
            } else {
                text = text.substring(0, maxWidth - 3) + '...';
            }
        }

        // Replace characters in the line at the specified position
        const lineArray = line.split('');
        for (let i = 0; i < text.length && startPos + i < lineArray.length; i++) {
            lineArray[startPos + i] = text[i];
        }

        return lineArray.join('');
    }

    updateStatus() {
        try {
            const newscanTags = this.client.user.properties['NewScanMessageAreaTags'] || '';
            const newscanArray = newscanTags.length > 0 ? newscanTags.split(',') : [];

            // Update status in top area (single line only)
            this.client.term.write(`\x1b[3;40H\x1b[32mSelected ${newscanArray.length} of ${this.availableAreas.length} areas for newscan\x1b[K\x1b[0m`);

        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in updateStatus');
        }
    }

    // Proper cleanup following Enigma patterns
    leave() {
        try {
            // Clear any display artifacts and reset cursor/colors
            const ansi = require('../../core/ansi_term.js');

            // Reset all graphics rendition and clear any lingering colors/styles
            this.client.term.rawWrite(ansi.normal());

            // Clear any potential scroll regions or other terminal state issues
            this.client.term.rawWrite('\x1b[r'); // Reset scroll region
            this.client.term.rawWrite('\x1b[?25h'); // Show cursor

        } catch (error) {
            this.client.log.error({ error: error.message }, 'Error in leave');
        }

        // Call parent leave method which will handle screen reset if cls is configured
        super.leave();
    }

    // Add finishedLoading method like other Enigma modules
    finishedLoading() {
        // Focus the vertical menu view
        const vm1 = this.viewControllers.main.getView(1);
        if (vm1) {
            vm1.setFocus(true);
        }
    }
};

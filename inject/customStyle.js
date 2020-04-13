(() => {
  const newStyleText = `
    .app-header-bar {
      background-color: #303030;
      border-bottom: 1px solid #444444;
    }
    .app-header-bar .me-profile:hover,
    body.acc-keyboard-mode .app-header-bar .me-profile:focus {
      background-color: #303030;
    }

    .app-bar {
      background-color: #393939;
    }
    .app-bar .app-bar-selected {
      background-color: #333333;
    }
    .app-bar .app-bar-selected::before {
      background-color: #ff0000;
    }
    .app-bar button:hover {
      background-color: #444444 !important;
    }

    .app-notification-banner.info-banner {
      background-color: #303030;
      color: #f0f0f0;
    }

    .ts-messages-header {
      background-color: #333333;
      color: #fefefe;
    }
    .ts-messages-header .ts-tab-bar-wrapper .tab-btn-container .tab-display-name {
      color: #cacaca;
    }

    .app-tabs .btn-default.app-tabs-selected, .app-tabs .icons-more.app-tabs-selected, .app-tabs .ts-tabs-chevron.app-tabs-selected {
      border-bottom-color: #cacaca;
    }
    .ts-messages-header .action-tab-btn {
      background-color: #333333;
      border-radius: 0;
    }
    .app-chat-header .app-title-bar-button.icons-call, .ts-title-bar-team-header .app-title-bar-button.icons-call {
      background-color: #333333;
    }
    .app-chat-header .app-title-bar-button.icons-call:focus, .app-chat-header .app-title-bar-button.icons-call:hover, .ts-title-bar-team-header .app-title-bar-button.icons-call:focus, .ts-title-bar-team-header .app-title-bar-button.icons-call:hover {
      background-color: #333333;
    }
    .messages-header-v2 .app-chat-header .app-title-bar-button.icons-open-outside, .messages-header-v2 .app-chat-header .app-title-bar-button.icons-team-create:not(.pop-out-chat-button) {
      width: auto;
    }
    .app-chat-header .app-icons-fill .icons-default,
    .app-chat-header .icons-default-fill,
    .app-chat-header .app-icons-fill-hover:hover .icons-default-fill {
      fill: #fefefe !important;
    }

    virtual-repeat>.list-wrap.list-wrap-v3>.item-wrap {
      background-color: #333333;
    }
    .ts-middle-messages-body .ts-message-content,
    .ts-middle-messages-body message-list {
      background-color: #333333;
    }
  `

  const newStyleElement = document.createElement('style')
  newStyleElement.textContent = newStyleText
  document.head.appendChild(newStyleElement)
})()

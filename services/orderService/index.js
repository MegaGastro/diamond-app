export const uploadOrder = async ({ order, store, access_token }) => {
  return fetch(process.env[`${store}_ORDER_UPLOAD_API`], {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${access_token}`,
      "Accept-Language": "en"
    },
    body: JSON.stringify({
      ...order
    })
  }).then(result=>result.json());
};

export const formatOrder = async ({ order, store }) => {
  var formatted_order;

  switch (store) {
    case "DIAMOND":
      formatted_order = await formatDiamondOrder({ order });
      break;
    case "HENDI":
      formatted_order = formatHendiOrder({ order });
      break;
    default:
      formatted_order = null;
      break;
  };

  return formatted_order;
};

const formatDiamondOrder = async ({ order }) => {
  //sample return
  return {
    comments: order.note,
    reference: order.name,
    is_draft: false,
    items: order.line_items.map((line_item)=>{
      return {
        id: line_item.sku,
        type: "products",
        qty: line_item.quantity,
        // name: line_item.name
      }
    }),
    delivery_address: {
      date: order.updated_at,
      type: "HOME",
      address: {
        company: order.shipping_address?.company || "",
        address: order.shipping_address?.address1 || "",
        address2: order.shipping_address?.address2 || "",
        postal_code: order.shipping_address?.zip || "",
        city: order.shipping_address?.city || "",
        country: order.shipping_address?.country || "",
        contact_name: order.shipping_address?.name || "",
        telephone_number: order.shipping_address?.phone || "",
        deliverToCompanyAddress: true
      }
    }
  }
};

const formatHendiOrder = ({ order }) => {
  //sample return
  return {
    comments: order.note,
    reference: order.name,
    is_draft: false,
    items: order.line_items.map((line_item)=>{
      return {
        id: line_item.sku,
        type: "products",
        qty: line_item.quantity,
        // name: line_item.name
      }
    }),
    delivery_address: {
      date: order.updated_at,
      type: "HOME",
      address: {
        company: order.shipping_address?.company || "",
        address: order.shipping_address?.address1 || "",
        address2: order.shipping_address?.address2 || "",
        postal_code: order.shipping_address?.zip || "",
        city: order.shipping_address?.city || "",
        country: order.shipping_address?.country || "",
        contact_name: order.shipping_address?.name || "",
        telephone_number: order.shipping_address?.phone || "",
        deliverToCompanyAddress: true
      }
    }
  }
};
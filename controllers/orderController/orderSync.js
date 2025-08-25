import { loginAPI } from "../../helpers/index.js";
import { formatOrder, uploadOrder } from "../../services/index.js";

export const syncOrder = async ({ order, store }) => {
  try {
    //using store's account to login API
    const access_token = await loginAPI({
      email: process.env[`${store}_EMAIL`],
      password: process.env[`${store}_PASSWORD`],
      store
    });

    if(!access_token)throw {
      status: 500,
      message: `Could not login to ${store}`
    };

    //format order data
    const formatted_order = await formatOrder({
      order,
      store
    });

    // console.log("formatted_order", formatted_order);

    if(!formatted_order)throw {
      status: 500,
      message: "Order Format Failed!"
    };

    //upload order
    const uploadOrderResult = await uploadOrder({
      order: formatted_order,
      store,
      access_token
    });

    // console.log("uploadOrderResult", uploadOrderResult);

    if(!uploadOrderResult.data)throw {
      status: 500,
      message: `Could not upload to ${store}`
    };
    
    return {
      status: "success"
    }
  } catch (error) {
    return {
      status: "error",
      error
    }
  }
};